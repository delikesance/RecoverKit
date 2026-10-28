import { handleResendWebhook } from '@/server/handlers/webhooks';
import { getDeps } from '@/server/runtime';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleResendWebhook(getDeps(), req);
