import { unsubscribe, type Deps } from '@recoverkit/services';
import { FORBIDDEN, csrfOk, redirectTo } from '../http';

function decodeEmail(value: string | null): string {
  try {
    return Buffer.from(value ?? '', 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

export async function handleUnsubscribe(deps: Deps, req: Request): Promise<Response> {
  const body = await req.text();
  const oneClick = body.includes('List-Unsubscribe=One-Click'); // POST automatique du client de messagerie, sans Origin
  if (!oneClick && !csrfOk(deps, req)) return FORBIDDEN();

  const q = new URL(req.url).searchParams;
  const r = await unsubscribe(deps, { tenantId: q.get('t') ?? '', email: decodeEmail(q.get('e')), signature: q.get('s') ?? '' });
  if (oneClick) return new Response(r.status === 'unsubscribed' ? 'ok' : 'invalid', { status: r.status === 'unsubscribed' ? 200 : 400 });
  return redirectTo(deps, r.status === 'unsubscribed' ? '/unsubscribe?done=1' : '/unsubscribe?error=1');
}
