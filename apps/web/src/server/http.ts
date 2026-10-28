import { checkCsrf, getSession, type Deps, type SessionIdentity } from '@recoverkit/services';

export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function redirectTo(deps: Deps, path: string, o: { status?: 301 | 302 | 303 | 307; headers?: Record<string, string> } = {}): Response {
  const headers = new Headers(o.headers);
  headers.set('location', `${deps.config.appUrl}${path}`);
  return new Response(null, { status: o.status ?? 303, headers });
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store, max-age=0', ...headers },
  });
}

export function csrfOk(deps: Deps, req: Request): boolean {
  return checkCsrf({ method: req.method, origin: req.headers.get('origin'), referer: req.headers.get('referer'), appUrl: deps.config.appUrl });
}

export async function sessionOf(deps: Deps, req: Request): Promise<SessionIdentity | null> {
  const token = getCookie(req, 'rk_session');
  return token ? getSession(deps, token) : null;
}

export const FORBIDDEN = () => jsonResponse({ error: 'forbidden' }, 403);
