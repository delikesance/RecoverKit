import { checkCsrf, getSession, type Deps, type SessionIdentity } from '@recoverkit/services';

/**
 * IP du client vue par notre proxy de confiance. Importable aussi par les pages serveur
 * (passer `await headers()`) : /pay/[token] et /pay/[token]/return doivent l'utiliser.
 * `hops` = nombre de proxys de confiance devant l'app (AppConfig.trustedProxyHops, défaut 1) :
 * on prend la N-ième entrée en partant de la DROITE, car la gauche est forgeable par le client.
 * Si la liste compte moins d'entrées que `hops`, elle n'a pas traversé tous nos proxys : elle est
 * entièrement forgeable, donc ignorée (« unknown »). `x-real-ip` n'est lu que si `trustRealIp`
 * (variable TRUST_X_REAL_IP=true, défaut non) : sinon un client pourrait choisir son identité.
 */
export function clientIp(src: Request | Headers, hops = 1, opts: { trustRealIp?: boolean } = {}): string {
  const headers = src instanceof Headers ? src : src.headers;
  const n = Math.max(1, hops);
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= n) return parts[parts.length - n]!;
    return 'unknown';
  }
  const trustRealIp = opts.trustRealIp ?? process.env.TRUST_X_REAL_IP === 'true';
  return (trustRealIp ? headers.get('x-real-ip')?.trim() : '') || 'unknown';
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Destination post-connexion : chemin STRICTEMENT interne sous /app, sinon null (aucun open-redirect). */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 512) return null;
  if (!/^\/app(?:[/?][\x21-\x7e]*)?$/.test(raw)) return null;
  if (raw.includes('\\') || raw.includes('//') || raw.includes('..') || raw.toLowerCase().includes('%2e') || raw.includes('%5c')) return null;
  try {
    const u = new URL(raw, 'http://internal.invalid');
    if (u.origin !== 'http://internal.invalid') return null;
  } catch {
    return null;
  }
  return raw;
}

export function redirectTo(deps: Deps, path: string, o: { status?: 301 | 302 | 303 | 307; headers?: Record<string, string> | Headers } = {}): Response {
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
