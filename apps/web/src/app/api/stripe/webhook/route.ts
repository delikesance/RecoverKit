import { handleStripeWebhook } from '@/server/handlers/webhooks';
import { getDeps } from '@/server/runtime';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleStripeWebhook(getDeps(), req);
