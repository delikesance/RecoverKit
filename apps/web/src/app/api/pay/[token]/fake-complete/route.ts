import { startSetup } from '@recoverkit/services';
import { clientIp, csrfOk, FORBIDDEN, jsonResponse } from '@/server/http';
import { getRuntime, isE2E } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const CARDS: Record<string, { behavior: 'succeed' | 'decline' | '3ds'; code?: string }> = {
  '4242424242424242': { behavior: 'succeed' },
  '4000000000000002': { behavior: 'decline', code: 'card_declined' },
  '4000000000009995': { behavior: 'decline', code: 'insufficient_funds' },
  '4000002500003155': { behavior: '3ds' },
};

/** Mode E2E uniquement : simule la saisie de carte de Stripe.js. Inexistant (404) en production. */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const rt = getRuntime();
  if (!isE2E() || !rt.e2e) return jsonResponse({ error: 'not_found' }, 404);
  if (!csrfOk(rt.deps, req)) return FORBIDDEN();
  const { token } = await params;
  const body: any = await req.json().catch(() => ({}));
  const number = String(body.number ?? '').replace(/\s/g, '');
  const card = CARDS[number] ?? CARDS['4242424242424242']!;
  const setup = await startSetup(rt.deps, token, { ip: clientIp(req, rt.deps.config.trustedProxyHops) });
  if (setup.status !== 'ok') return jsonResponse({ status: setup.status }, 409);
  const pm = `pm_fake_${number || 'default'}_${setup.setupIntentId}`;
  rt.e2e.stripe.setCardBehavior(pm, card.behavior, card.code);
  rt.e2e.stripe.completeSetupIntent(setup.account, setup.setupIntentId, pm);
  return jsonResponse({ setupIntentId: setup.setupIntentId });
}
