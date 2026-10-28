import { handleE2E } from '@/server/handlers/e2e';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ action: string }> }) {
  return handleE2E(getRuntime(), req, (await ctx.params).action, process.env);
}
export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  return handleE2E(getRuntime(), req, (await ctx.params).action, process.env);
}
