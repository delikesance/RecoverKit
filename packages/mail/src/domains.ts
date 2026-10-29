import { MailerError } from './mailer';

export type DomainStatus = 'pending' | 'verified' | 'failed';

export interface DnsRecord {
  purpose: 'SPF' | 'DKIM' | 'DMARC' | 'RETURN_PATH';
  type: 'TXT' | 'MX' | 'CNAME';
  name: string;
  value: string;
  priority?: number;
}

export interface SenderDomain {
  id: string;
  name: string;
  status: DomainStatus;
  records: DnsRecord[];
}

/** Gestion des domaines d'envoi chez le fournisseur d'email (SPF, DKIM, vérification). */
export interface DomainProvider {
  createDomain(name: string): Promise<SenderDomain>;
  getDomain(id: string): Promise<SenderDomain>;
  verifyDomain(id: string): Promise<void>;
  deleteDomain(id: string): Promise<void>;
}

const DMARC: DnsRecord = { purpose: 'DMARC', type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=none;' };

export class FakeDomainProvider implements DomainProvider {
  private domains = new Map<string, SenderDomain>();
  readonly deleted: string[] = [];
  private seq = 0;

  async createDomain(name: string): Promise<SenderDomain> {
    const id = `dom_fake_${++this.seq}`;
    const d: SenderDomain = {
      id,
      name,
      status: 'pending',
      records: [
        { purpose: 'SPF', type: 'TXT', name: 'send', value: 'v=spf1 include:amazonses.com ~all' },
        { purpose: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: 'p=FAKEKEY' },
        DMARC,
      ],
    };
    this.domains.set(id, d);
    return structuredClone(d);
  }
  async getDomain(id: string): Promise<SenderDomain> {
    const d = this.domains.get(id);
    if (!d) throw new MailerError('Domaine introuvable', { permanent: true });
    return structuredClone(d);
  }
  async verifyDomain(id: string): Promise<void> {
    await this.getDomain(id);
  }
  async deleteDomain(id: string): Promise<void> {
    this.domains.delete(id);
    this.deleted.push(id);
  }
  markVerified(id: string): void {
    this.domains.get(id)!.status = 'verified';
  }
  markFailed(id: string): void {
    this.domains.get(id)!.status = 'failed';
  }
}

export class ResendDomainProvider implements DomainProvider {
  private readonly baseUrl: string;
  constructor(private readonly opts: { apiKey: string; baseUrl?: string; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl ?? 'https://api.resend.com';
  }

  private async call(method: string, path: string, body?: unknown, parse = true): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new MailerError(`Erreur réseau : ${(e as Error).message}`, { permanent: false });
    }
    if (!res.ok) {
      // Seuls 400/422 (requête invalide) sont définitifs ; 401/403/409/429/5xx se corrigent et se rejouent
      const permanent = res.status === 400 || res.status === 422;
      throw new MailerError(`Resend a répondu ${res.status}`, { permanent });
    }
    if (!parse) return undefined;
    try {
      return await res.json();
    } catch (e) {
      throw new MailerError(`Réponse Resend illisible : ${(e as Error).message}`, { permanent: false });
    }
  }

  private map(d: any): SenderDomain {
    const status: DomainStatus = d.status === 'verified' ? 'verified' : d.status === 'failed' ? 'failed' : 'pending';
    const records: DnsRecord[] = (d.records ?? []).map((r: any) => ({
      purpose: r.record === 'DKIM' ? 'DKIM' : 'SPF',
      type: r.type,
      name: r.name,
      value: r.value,
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
    }));
    records.push(DMARC);
    return { id: d.id, name: d.name, status, records };
  }

  async createDomain(name: string): Promise<SenderDomain> {
    return this.map(await this.call('POST', '/domains', { name }));
  }
  async getDomain(id: string): Promise<SenderDomain> {
    return this.map(await this.call('GET', `/domains/${id}`));
  }
  async verifyDomain(id: string): Promise<void> {
    await this.call('POST', `/domains/${id}/verify`, undefined, false);
  }
  async deleteDomain(id: string): Promise<void> {
    await this.call('DELETE', `/domains/${id}`, undefined, false);
  }
}
