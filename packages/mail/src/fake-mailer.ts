import { MailerError, type Mailer, type OutboundEmail } from './mailer';

/** Mailer de test : capture, dédoublonne par clé d'idempotence, et détecte les doubles envois. */
export class FakeMailer implements Mailer {
  readonly sent: OutboundEmail[] = [];
  private readonly byKey = new Map<string, { messageId: string; fingerprint: string }>();
  private failures: Error[] = [];
  private counter = 0;

  failNext(error: Error): void {
    this.failures.push(error);
  }

  messagesTo(to: string): OutboundEmail[] {
    return this.sent.filter((e) => e.to === to);
  }

  async send(email: OutboundEmail): Promise<{ messageId: string }> {
    const failure = this.failures.shift();
    if (failure) throw failure;

    const fingerprint = JSON.stringify([email.to, email.subject, email.html, email.text, email.from, email.replyTo]);
    const known = this.byKey.get(email.idempotencyKey);
    if (known) {
      if (known.fingerprint !== fingerprint) {
        throw new MailerError(`clé d'idempotence ${email.idempotencyKey} réutilisée avec un contenu différent`, {
          permanent: true,
        });
      }
      return { messageId: known.messageId };
    }
    const messageId = `fake_${++this.counter}`;
    this.byKey.set(email.idempotencyKey, { messageId, fingerprint });
    this.sent.push(email);
    return { messageId };
  }
}
