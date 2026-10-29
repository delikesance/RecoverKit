import { startSetup, type Deps } from '@recoverkit/services';
import { FORBIDDEN, clientIp, csrfOk, jsonResponse } from '../http';

/** Crée le SetupIntent pour le lien de paiement. Le secret n'est jamais mis en cache. */
export async function handlePaySetup(deps: Deps, req: Request, token: string): Promise<Response> {
  if (!csrfOk(deps, req)) return FORBIDDEN();
  const r = await startSetup(deps, token, { ip: clientIp(req, deps.config.trustedProxyHops) });
  switch (r.status) {
    case 'ok':
      return jsonResponse({ clientSecret: r.clientSecret, setupIntentId: r.setupIntentId, account: r.account, publishableKey: r.publishableKey });
    case 'unavailable':
      return jsonResponse({ status: 'unavailable' }, 404);
    case 'paid':
      return jsonResponse({ status: 'paid' }, 409);
    case 'rate_limited':
      return jsonResponse({ status: 'rate_limited' }, 429, { 'retry-after': '60' });
    default:
      return jsonResponse({ status: 'error' }, 502);
  }
}
