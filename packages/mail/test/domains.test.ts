import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ResendDomainProvider, MailerError } from '../src';

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

  it('seuls 400/422 sont permanents ; 401/403/409/429/5xx se corrigent et se rejouent', async () => {
    for (const [status, permanent] of [[400, true], [422, true], [401, false], [403, false], [404, false], [409, false], [429, false], [500, false], [503, false]] as const) {
      const { baseUrl } = await start(() => ({ status, json: { message: 'x' } }));
      const err = await new ResendDomainProvider({ apiKey: 'k', baseUrl }).createDomain('x.example').catch((e) => e);
      expect(err).toBeInstanceOf(MailerError);
      expect(err.permanent, `statut ${status}`).toBe(permanent);
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });

  it('un fournisseur qui ne répond pas : délai dépassé, erreur temporaire', async () => {
    server = createServer(() => {
      /* ne répond jamais */
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const err = await new ResendDomainProvider({ apiKey: 'k', baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 200 }).getDomain('d').catch((e) => e);
    expect(err).toBeInstanceOf(MailerError);
    expect(err.permanent).toBe(false);
    server.closeAllConnections();
  });

  async function rawServer(status: number, text: string) {
    const seen: { method?: string; url?: string }[] = [];
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url });
        res.writeHead(status, text ? { 'content-type': 'application/json' } : {});
        res.end(text);
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
  }

  it('corps non JSON sur une réponse 200 : MailerError temporaire, pas de SyntaxError brute', async () => {
    const { baseUrl } = await rawServer(200, '<html>bad gateway</html>');
    const err = await new ResendDomainProvider({ apiKey: 'k', baseUrl }).getDomain('d').catch((e) => e);
    expect(err).toBeInstanceOf(MailerError);
    expect(err.permanent).toBe(false);
  });

  it('verifyDomain et deleteDomain acceptent un 204 sans corps ou un corps non JSON', async () => {
    for (const [status, text] of [[204, ''], [200, 'ok']] as const) {
      const { baseUrl, seen } = await rawServer(status, text);
      const p = new ResendDomainProvider({ apiKey: 'k', baseUrl });
      await expect(p.verifyDomain('dom_1')).resolves.toBeUndefined();
      await expect(p.deleteDomain('dom_1')).resolves.toBeUndefined();
      expect(seen.map((s) => s.method)).toEqual(['POST', 'DELETE']);
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });
});
