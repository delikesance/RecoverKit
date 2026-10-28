import { handleExportData } from '@/server/handlers/exports';
import { getDeps } from '@/server/runtime';

export const dynamic = 'force-dynamic';
export const GET = (req: Request) => handleExportData(getDeps(), req);
