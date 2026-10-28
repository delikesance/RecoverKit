import { handleHealth } from '@/server/handlers/health';
import { getDeps } from '@/server/runtime';

export const dynamic = 'force-dynamic';
export const GET = () => handleHealth(getDeps());
