import { handleOauthCallback } from '@/server/handlers/oauth';
import { getDeps } from '@/server/runtime';

export const dynamic = 'force-dynamic';
export const GET = (req: Request) => handleOauthCallback(getDeps(), req);
