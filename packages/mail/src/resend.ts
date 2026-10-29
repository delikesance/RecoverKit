import { MailerError, type Mailer, type OutboundEmail } from './mailer';

export interface ResendOptions {
  apiKey: string;
  baseUrl?: string;
  /** Délai maximal d'un appel, en ms (15 s par défaut). */
  timeoutMs?: number;
}

export class ResendMailer implements Mailer {
  private readonly baseUrl: string;
  constructor(private readonly opts: ResendOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.resend.com';
  }

  async send(email: OutboundEmail): Promise<{ messageId: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': email.idempotencyKey,
        },
        body: JSON.stringify({
          from: `${email.from.name} <${email.from.email}>`,
          to: [email.to],
          reply_to: email.replyTo,
          subject: email.subject,
          html: email.html,
          text: email.text,
          headers: email.headers,
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new MailerError(`Erreur réseau : ${(e as Error).message}`, { permanent: false });
    }
    if (!res.ok) {
      // Seuls 400/422 (contenu ou adresse invalide) sont définitifs ; 401/403/409/5xx se corrigent et se rejouent
      const permanent = res.status === 400 || res.status === 422;
      throw new MailerError(`Resend a répondu ${res.status}`, { permanent });
    }
    try {
      const json = (await res.json()) as { id: string };
      return { messageId: json.id };
    } catch (e) {
      // Corps coupé ou délai dépassé : l'envoi a peut-être eu lieu, la clé d'idempotence protège du doublon au rejeu
      throw new MailerError(`Réponse Resend illisible : ${(e as Error).message}`, { permanent: false });
    }
  }
}
