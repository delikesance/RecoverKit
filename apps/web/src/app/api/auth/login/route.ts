import { handleLoginRequest } from '@/server/handlers/auth';
import { getDeps } from '@/server/runtime';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleLoginRequest(getDeps(), req);
