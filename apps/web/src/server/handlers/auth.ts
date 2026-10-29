import {
  consumeLoginLink,
  getOnboardingStatus,
  requestLoginLink,
  revokeSession,
  serializeSessionCookie,
  type Deps,
} from '@recoverkit/services';
import { FORBIDDEN, clientIp, csrfOk, getCookie, redirectTo, safeNextPath } from '../http';

const secure = (deps: Deps) => deps.config.appUrl.startsWith('https://');

export async function handleLoginRequest(deps: Deps, req: Request): Promise<Response> {
  if (!csrfOk(deps, req)) return FORBIDDEN();
  const form = await req.formData();
  const r = await requestLoginLink(deps, String(form.get('email') ?? ''), { ip: clientIp(req, deps.config.trustedProxyHops) });
  // Réponse identique que l'adresse existe ou non : aucune énumération de comptes.
  if (r.status === 'sent') return redirectTo(deps, '/login?sent=1');
  return redirectTo(deps, `/login?error=${r.status}`);
}

/** Le lien de l'email ouvre une page de confirmation ; seule ce POST consomme le jeton (les scanners d'emails ne le brûlent pas). */
export async function handleAuthConsume(deps: Deps, req: Request): Promise<Response> {
  if (!csrfOk(deps, req)) return FORBIDDEN();
  const form = await req.formData();
  const out = await consumeLoginLink(deps, String(form.get('token') ?? ''));
  if (out.status !== 'ok') return redirectTo(deps, '/login?error=link');
  const onboarding = await getOnboardingStatus(deps, out.tenantId);
  const next = safeNextPath(getCookie(req, 'rk_next'));
  const headers = new Headers({ 'set-cookie': serializeSessionCookie(out.sessionToken, { secure: secure(deps) }) });
  headers.append('set-cookie', `rk_next=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure(deps) ? '; Secure' : ''}`);
  return redirectTo(deps, next ?? (onboarding.complete ? '/app' : '/app/onboarding'), { headers });
}

export async function handleLogout(deps: Deps, req: Request): Promise<Response> {
  if (!csrfOk(deps, req)) return FORBIDDEN();
  const token = getCookie(req, 'rk_session');
  if (token) await revokeSession(deps, token);
  return redirectTo(deps, '/', { headers: { 'set-cookie': serializeSessionCookie('', { secure: secure(deps), clear: true }) } });
}
