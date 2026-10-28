import { handlePaySetup } from '@/server/handlers/pay';
import { getDeps } from '@/server/runtime';

export const dynamic = 'force-dynamic';
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return handlePaySetup(getDeps(), req, token);
}
