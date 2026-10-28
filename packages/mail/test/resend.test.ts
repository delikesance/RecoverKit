import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MailerError, ResendMailer, type OutboundEmail } from '../src';

let server: Server | undefined;
afterEach(() => server?.close());

async function start(handler: (req: IncomingMessage, body: string) => { status: number; json: unknown }) {
  const seen: { headers: IncomingMessage['headers']; body: any }[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const out = handler(req, raw);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server!.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}`, seen };
}

const email: OutboundEmail = {
  to: 'camille@example.com',
  from: { name: 'Nimbus Notes', email: 'billing@mail.recoverkit.example' },
  replyTo: 'support@nimbusnotes.example',
  subject: 'Sujet',
  html: '<p>x</p>',
  text: 'x',
  idempotencyKey: 'case1:0',
  headers: { 'List-Unsubscribe': '<https://app.example/u/abc>' },
};

describe('ResendMailer', () => {
  it("envoie la clé d'idempotence, l'auth et les champs attendus", async () => {
    const { baseUrl, seen } = await start(() => ({ status: 200, json: { id: 'msg_123' } }));
    const r = await new ResendMailer({ apiKey: 're_test', baseUrl }).send(email);
    expect(r.messageId).toBe('msg_123');
    expect(seen[0]!.headers['idempotency-key']).toBe('case1:0');
    expect(seen[0]!.headers.authorization).toBe('Bearer re_test');
    expect(seen[0]!.body).toMatchObject({
      from: 'Nimbus Notes <billing@mail.recoverkit.example>',
      to: ['camille@example.com'],
      reply_to: 'support@nimbusnotes.example',
      subject: 'Sujet',
      html: '<p>x</p>',
      text: 'x',
      headers: { 'List-Unsubscribe': '<https://app.example/u/abc>' },
    });
  });

  it('erreur 422 = permanente (pas de retry)', async () => {
    const { baseUrl } = await start(() => ({ status: 422, json: { message: 'invalid to' } }));
    const err = await new ResendMailer({ apiKey: 'k', baseUrl }).send(email).catch((e) => e);
    expect(err).toBeInstanceOf(MailerError);
    expect(err.permanent).toBe(true);
  });

  it('429 et 5xx = temporaires', async () => {
    for (const status of [429, 500, 503]) {
      const { baseUrl } = await start(() => ({ status, json: { message: 'oops' } }));
      const err = await new ResendMailer({ apiKey: 'k', baseUrl }).send(email).catch((e) => e);
      expect(err.permanent).toBe(false);
      server!.close();
    }
  });

  it('erreur réseau = temporaire', async () => {
    const err = await new ResendMailer({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1' }).send(email).catch((e) => e);
    expect(err).toBeInstanceOf(MailerError);
    expect(err.permanent).toBe(false);
  });
});
