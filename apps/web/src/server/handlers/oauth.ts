import { buildConnectUrl, handleOAuthCallback, type Deps } from '@recoverkit/services';
import { redirectTo, sessionOf } from '../http';

export async function handleOauthStart(deps: Deps, req: Request): Promise<Response> {
  const session = await sessionOf(deps, req);
  if (!session) return redirectTo(deps, '/login');
  const url = await buildConnectUrl(deps, session);
  return new Response(null, { status: 302, headers: { location: url } });
}

const OUTCOME: Record<string, string> = {
  connected: 'connected',
  denied: 'denied',
  invalid_state: 'invalid',
  exchange_failed: 'error',
  account_taken: 'taken',
};

export async function handleOauthCallback(deps: Deps, req: Request): Promise<Response> {
  const session = await sessionOf(deps, req);
  if (!session) return redirectTo(deps, '/login');
  const q = new URL(req.url).searchParams;
  const r = await handleOAuthCallback(deps, session, {
    code: q.get('code') ?? undefined,
    state: q.get('state') ?? undefined,
    error: q.get('error') ?? undefined,
  });
  return redirectTo(deps, `/app/onboarding?stripe=${OUTCOME[r.status]}`);
}
