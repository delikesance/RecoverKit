import { z } from 'zod';

const planSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  priceId: z.string().min(1),
  /** Revenu mensuel récurrent maximal du palier, en unités mineures. */
  maxMrr: z.number().int().positive().nullable(),
  monthlyPrice: z.number().int().nonnegative(),
  /** Devise du palier (ISO 4217, 3 majuscules) : celle de maxMrr. EUR par défaut. */
  currency: z.string().regex(/^[A-Z]{3}$/).default('EUR'),
});
/** `currency` reste facultative pour qui construit un palier à la main : EUR si absente. */
export type Plan = Omit<z.infer<typeof planSchema>, 'currency'> & { currency?: string };

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  APP_URL: z.string().url(),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PLATFORM_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_CONNECT_CLIENT_ID: z.string().min(1),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().min(1),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  SYSTEM_FROM_EMAIL: z.string().email(),
  DEFAULT_FROM_EMAIL: z.string().email().optional(),
  TOKEN_SECRET: z.string().min(32),
  PLANS: z.string().optional(),
  INBOX_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  TRIAL_DAYS: z.coerce.number().int().min(0).default(14),
  BILLING_GRACE_DAYS: z.coerce.number().int().min(0).default(7),
  STEP_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  ADMIN_TOKEN: z.string().optional(),
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).default(1),
  LEGAL_COMPANY_NAME: z.string().optional(),
  LEGAL_ADDRESS: z.string().optional(),
  LEGAL_PUBLISHER: z.string().optional(),
  LEGAL_HOST_NAME: z.string().optional(),
  LEGAL_HOST_ADDRESS: z.string().optional(),
  LEGAL_CONTACT_EMAIL: z.string().email().optional(),
  LEGAL_DPO_EMAIL: z.string().email().optional(),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  appUrl: string;
  stripeSecretKey: string;
  stripeConnectWebhookSecret: string;
  stripePlatformWebhookSecret: string;
  stripeConnectClientId: string;
  stripePublishableKey: string;
  resendApiKey: string;
  resendWebhookSecret: string | null;
  systemFromEmail: string;
  defaultFromEmail: string;
  tokenSecret: string;
  plans: Plan[];
  inboxBatchSize: number;
  stepBatchSize: number;
  trialDays: number;
  billingGraceDays: number;
  adminToken: string | null;
  /** Nombre de proxys de confiance devant l'app (lecture de X-Forwarded-For depuis la droite). */
  trustedProxyHops: number;
  legal: LegalConfig;
  /** Clés LEGAL_* requises pour les mentions légales mais absentes (jamais bloquant au démarrage). */
  legalMissing: string[];
}

export interface LegalConfig {
  companyName: string | null;
  address: string | null;
  publisher: string | null;
  hostName: string | null;
  hostAddress: string | null;
  contactEmail: string | null;
  dpoEmail: string | null;
}

const REQUIRED_LEGAL_KEYS = ['LEGAL_COMPANY_NAME', 'LEGAL_ADDRESS', 'LEGAL_PUBLISHER', 'LEGAL_HOST_NAME', 'LEGAL_CONTACT_EMAIL'] as const;

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join('\n');
    throw new Error(`Configuration invalide :\n${detail}`);
  }
  const e = parsed.data;

  let plans: Plan[] = [];
  if (e.PLANS) {
    try {
      plans = z.array(planSchema).parse(JSON.parse(e.PLANS));
    } catch (err) {
      throw new Error(`Configuration invalide : PLANS doit être un tableau JSON de paliers valides (${(err as Error).message})`);
    }
    if (new Set(plans.map((p) => p.currency)).size > 1) {
      throw new Error('Configuration invalide : PLANS doit utiliser une seule devise pour tous les paliers (le palier conseillé compare un revenu à maxMrr)');
    }
  }
  if (e.NODE_ENV === 'production' && !e.APP_URL.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(e.APP_URL)) {
    throw new Error('Configuration invalide : APP_URL doit utiliser HTTPS en production (seul localhost est toléré en http)');
  }

  return {
    nodeEnv: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL,
    appUrl: e.APP_URL.replace(/\/$/, ''),
    stripeSecretKey: e.STRIPE_SECRET_KEY,
    stripeConnectWebhookSecret: e.STRIPE_CONNECT_WEBHOOK_SECRET,
    stripePlatformWebhookSecret: e.STRIPE_PLATFORM_WEBHOOK_SECRET,
    stripeConnectClientId: e.STRIPE_CONNECT_CLIENT_ID,
    stripePublishableKey: e.STRIPE_PUBLISHABLE_KEY ?? '',
    resendApiKey: e.RESEND_API_KEY,
    resendWebhookSecret: e.RESEND_WEBHOOK_SECRET ?? null,
    systemFromEmail: e.SYSTEM_FROM_EMAIL,
    defaultFromEmail: e.DEFAULT_FROM_EMAIL ?? e.SYSTEM_FROM_EMAIL,
    tokenSecret: e.TOKEN_SECRET,
    plans,
    inboxBatchSize: e.INBOX_BATCH_SIZE,
    stepBatchSize: e.STEP_BATCH_SIZE,
    trialDays: e.TRIAL_DAYS,
    billingGraceDays: e.BILLING_GRACE_DAYS,
    adminToken: e.ADMIN_TOKEN ?? null,
    trustedProxyHops: e.TRUSTED_PROXY_HOPS,
    legalMissing: REQUIRED_LEGAL_KEYS.filter((k) => !e[k]),
    legal: {
      companyName: e.LEGAL_COMPANY_NAME ?? null,
      address: e.LEGAL_ADDRESS ?? null,
      publisher: e.LEGAL_PUBLISHER ?? null,
      hostName: e.LEGAL_HOST_NAME ?? null,
      hostAddress: e.LEGAL_HOST_ADDRESS ?? null,
      contactEmail: e.LEGAL_CONTACT_EMAIL ?? null,
      dpoEmail: e.LEGAL_DPO_EMAIL ?? null,
    },
  };
}
