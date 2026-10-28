import { MailerError, type Mailer, type OutboundEmail } from './mailer';

export interface ResendOptions {
  apiKey: string;
  baseUrl?: string;
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
      });
    } catch (e) {
      throw new MailerError(`Erreur réseau : ${(e as Error).message}`, { permanent: false });
    }
    if (!res.ok) {
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408;
      throw new MailerError(`Resend a répondu ${res.status}`, { permanent });
    }
    const json = (await res.json()) as { id: string };
    return { messageId: json.id };
  }
}
