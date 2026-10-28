export const SESSION_COOKIE = 'rk_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;

export function serializeSessionCookie(value: string, o: { secure: boolean; clear?: boolean }): string {
  const parts = [
    `${SESSION_COOKIE}=${o.clear ? '' : value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${o.clear ? 0 : SESSION_TTL_SECONDS}`,
  ];
  if (o.secure) parts.push('Secure');
  return parts.join('; ');
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Protection CSRF : toute requête mutante doit venir de l'origine de l'application. */
export function checkCsrf(r: { method: string; origin?: string | null; referer?: string | null; appUrl: string }): boolean {
  if (SAFE_METHODS.has(r.method.toUpperCase())) return true;
  const expected = new URL(r.appUrl).origin;
  if (r.origin) return r.origin === expected;
  if (r.referer) {
    try {
      return new URL(r.referer).origin === expected;
    } catch {
      return false;
    }
  }
  return false;
}
