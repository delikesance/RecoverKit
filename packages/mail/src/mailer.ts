export interface OutboundEmail {
  to: string;
  from: { name: string; email: string };
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  /** Clé stable `${caseId}:${stepIndex}` : le fournisseur dédoublonne les envois identiques. */
  idempotencyKey: string;
  headers?: Record<string, string>;
}

export interface Mailer {
  send(email: OutboundEmail): Promise<{ messageId: string }>;
}

export class MailerError extends Error {
  readonly permanent: boolean;
  constructor(message: string, opts: { permanent: boolean }) {
    super(message);
    this.name = 'MailerError';
    this.permanent = opts.permanent;
  }
}
