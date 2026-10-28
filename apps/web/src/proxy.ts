import { NextResponse, type NextRequest } from 'next/server';

/**
 * Première barrière : pas de cookie, pas d'accès à /app. La validité de la session est
 * toujours revérifiée côté serveur (requireSession) avant toute lecture de données.
 */
export function proxy(request: NextRequest) {
  const cookie = request.cookies.get('rk_session')?.value;
  if (cookie) return NextResponse.next();
  const url = new URL('/login', request.url);
  const next = request.nextUrl.pathname + request.nextUrl.search;
  if (next !== '/app') url.searchParams.set('next', next);
  return NextResponse.redirect(url);
}

export const config = { matcher: ['/app/:path*'] };
