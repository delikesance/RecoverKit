import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeDomainProvider, ResendDomainProvider, MailerError } from '../src';

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(handler: (req: IncomingMessage, body: any) => { status: number; json: unknown }) {
  const seen: { method?: string; url?: string; headers: IncomingMessage['headers']; body: any }[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const out = handler(req, body);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

const resendDomain = (status: string) => ({
  id: 'dom_1',
  name: 'nimbusnotes.example',
  status,
  records: [
    { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10, status: 'not_started' },
    { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', status: 'not_started' },
    { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGfMA0...', status: 'not_started' },
  ],
});

describe('ResendDomainProvider', () => {
  it('crée un domaine et renvoie les enregistrements DNS (SPF, DKIM) plus un DMARC recommandé', async () => {
    const { baseUrl, seen } = await start(() => ({ status: 201, json: resendDomain('not_started') }));
    const d = await new ResendDomainProvider({ apiKey: 're_x', baseUrl }).createDomain('nimbusnotes.example');
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/domains', body: { name: 'nimbusnotes.example' } });
    expect(seen[0]!.headers.authorization).toBe('Bearer re_x');
    expect(d).toMatchObject({ id: 'dom_1', status: 'pending' });
    expect(d.records.map((r) => r.purpose)).toEqual(expect.arrayContaining(['SPF', 'DKIM', 'DMARC']));
    expect(d.records.find((r) => r.purpose === 'DMARC')).toMatchObject({ type: 'TXT', name: '_dmarc' });
  });

  it('getDomain traduit les statuts du fournisseur', async () => {
    for (const [remote, local] of [['verified', 'verified'], ['pending', 'pending'], ['not_started', 'pending'], ['failed', 'failed'], ['temporary_failure', 'pending']] as const) {
      const { baseUrl } = await start(() => ({ status: 200, json: resendDomain(remote) }));
      expect((await new ResendDomainProvider({ apiKey: 'k', baseUrl }).getDomain('dom_1')).status).toBe(local);
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });

  it('verifyDomain déclenche la vérification', async () => {
    const { baseUrl, seen } = await start(() => ({ status: 200, json: { object: 'domain', id: 'dom_1' } }));
    await new ResendDomainProvider({ apiKey: 'k', baseUrl }).verifyDomain('dom_1');
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/domains/dom_1/verify' });
  });

  it('deleteDomain supprime le domaine', async () => {
    const { baseUrl, seen } = await start(() => ({ status: 200, json: { deleted: true } }));
    await new ResendDomainProvider({ apiKey: 'k', baseUrl }).deleteDomain('dom_1');
    expect(seen[0]).toMatchObject({ method: 'DELETE', url: '/domains/dom_1' });
  });

  it('erreur 4xx permanente, 5xx temporaire', async () => {
    const a = await start(() => ({ status: 403, json: { message: 'domain already registered' } }));
    const e1 = await new ResendDomainProvider({ apiKey: 'k', baseUrl: a.baseUrl }).createDomain('x.example').catch((e) => e);
    expect(e1).toBeInstanceOf(MailerError);
    expect(e1.permanent).toBe(true);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const b = await start(() => ({ status: 503, json: {} }));
    const e2 = await new ResendDomainProvider({ apiKey: 'k', baseUrl: b.baseUrl }).getDomain('d').catch((e) => e);
    expect(e2.permanent).toBe(false);
  });
});

describe('FakeDomainProvider', () => {
  it('crée, vérifie et supprime', async () => {
    const f = new FakeDomainProvider();
    const d = await f.createDomain('nimbusnotes.example');
    expect(d.status).toBe('pending');
    expect(d.records.length).toBeGreaterThan(0);
    await f.verifyDomain(d.id);
    expect((await f.getDomain(d.id)).status).toBe('pending');
    f.markVerified(d.id);
    expect((await f.getDomain(d.id)).status).toBe('verified');
    await f.deleteDomain(d.id);
    expect(f.deleted).toContain(d.id);
    await expect(f.getDomain(d.id)).rejects.toThrow(/introuvable/);
  });
});
