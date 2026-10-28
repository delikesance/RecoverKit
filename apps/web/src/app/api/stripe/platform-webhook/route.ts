import { handlePlatformWebhook } from '@/server/handlers/webhooks';
import { getDeps } from '@/server/runtime';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handlePlatformWebhook(getDeps(), req);
