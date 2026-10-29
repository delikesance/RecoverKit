import { describe, expect, it } from 'vitest';
import { FakeMailer, MailerError, type OutboundEmail } from '../src';

const email = (over: Partial<OutboundEmail> = {}): OutboundEmail => ({
  to: 'camille@example.com',
  from: { name: 'Nimbus Notes', email: 'billing@mail.recoverkit.example' },
  replyTo: 'support@nimbusnotes.example',
  subject: 'Votre paiement a échoué',
  html: '<p>Bonjour</p>',
  text: 'Bonjour',
  idempotencyKey: 'case1:0',
  ...over,
});

describe('FakeMailer', () => {
  it('capture les messages et renvoie un messageId', async () => {
    const m = new FakeMailer();
    const r = await m.send(email());
    expect(r.messageId).toMatch(/^fake_/);
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]!.to).toBe('camille@example.com');
  });

  it("dédoublonne une même clé d'idempotence avec un contenu identique (comme le fournisseur)", async () => {
    const m = new FakeMailer();
    const a = await m.send(email());
    const b = await m.send(email());
    expect(b.messageId).toBe(a.messageId);
    expect(m.sent).toHaveLength(1);
  });

  it('mode strict : même clé mais contenu différent = erreur (double envoi détecté)', async () => {
    const m = new FakeMailer();
    await m.send(email());
    await expect(m.send(email({ subject: 'Autre sujet' }))).rejects.toThrow(/clé d'idempotence/);
  });

  it('simule une erreur temporaire puis un succès', async () => {
    const m = new FakeMailer();
    m.failNext(new MailerError('timeout', { permanent: false }));
    await expect(m.send(email())).rejects.toMatchObject({ permanent: false });
    await expect(m.send(email())).resolves.toBeDefined();
    expect(m.sent).toHaveLength(1);
  });

  it('simule une erreur permanente', async () => {
    const m = new FakeMailer();
    m.failNext(new MailerError('adresse invalide', { permanent: true }));
    await expect(m.send(email())).rejects.toMatchObject({ permanent: true });
  });

  it('retrouve les messages par destinataire', async () => {
    const m = new FakeMailer();
    await m.send(email({ idempotencyKey: 'a:0' }));
    await m.send(email({ idempotencyKey: 'b:0', to: 'autre@example.com' }));
    expect(m.messagesTo('autre@example.com')).toHaveLength(1);
  });

  it('compte chaque appel à send par clé, y compris les rejeux dédoublonnés et les échecs', async () => {
    const m = new FakeMailer();
    await m.send(email());
    await m.send(email());
    m.failNext(new MailerError('timeout', { permanent: false }));
    await expect(m.send(email())).rejects.toBeDefined();
    expect(m.sent).toHaveLength(1);
    expect(m.callCount('case1:0')).toBe(3);
    expect(m.callCount('inconnue')).toBe(0);
  });
});
