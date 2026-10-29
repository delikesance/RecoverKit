import { NextResponse, type NextRequest } from 'next/server';
import { FLASH_COOKIE, FLASH_HEADER } from './lib/flash';

/**
 * Première barrière : pas de cookie, pas d'accès à /app. La validité de la session est
 * toujours revérifiée côté serveur (requireSession) avant toute lecture de données.
 */
export function proxy(request: NextRequest) {
  const cookie = request.cookies.get('rk_session')?.value;
  if (cookie) {
    // Flash (erreur / brouillon posé par une action) : transmis à la page par un en-tête interne puis
    // effacé, donc lu une seule fois. L'en-tête éventuellement envoyé par le client est toujours écarté.
    const headers = new Headers(request.headers);
    headers.delete(FLASH_HEADER);
    const flash = request.cookies.get(FLASH_COOKIE)?.value;
    if (flash) headers.set(FLASH_HEADER, encodeURIComponent(flash));
    const res = NextResponse.next({ request: { headers } });
    if (flash) res.cookies.set(FLASH_COOKIE, '', { path: '/app', maxAge: 0, httpOnly: true, sameSite: 'lax' });
    return res;
  }
  const url = new URL('/login', request.url);
  const next = request.nextUrl.pathname + request.nextUrl.search;
  if (next !== '/app') url.searchParams.set('next', next);
  const res = NextResponse.redirect(url);
  // Cookie court relu par handleAuthConsume (revalidé : chemin /app uniquement).
  if (next !== '/app') res.cookies.set('rk_next', next, { path: '/', maxAge: 900, httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:' });
  return res;
}

export const config = { matcher: ['/app/:path*'] };
