import { handleHealthDetails } from '@/server/handlers/health';
import { getDeps } from '@/server/runtime';

export const dynamic = 'force-dynamic';
export const GET = (req: Request) => handleHealthDetails(getDeps(), req);
