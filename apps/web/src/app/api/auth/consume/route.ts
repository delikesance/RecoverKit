import { handleAuthConsume } from '@/server/handlers/auth';
import { getDeps } from '@/server/runtime';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleAuthConsume(getDeps(), req);
