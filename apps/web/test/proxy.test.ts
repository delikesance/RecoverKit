import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { config, proxy } from '../src/proxy';

const req = (path: string, cookie?: string) => new NextRequest(`https://app.recoverkit.test${path}`, { headers: cookie ? { cookie } : {} });

describe('proxy (garde de l’espace fondateur)', () => {
  it('redirige vers /login sans cookie de session', () => {
    const res = proxy(req('/app'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://app.recoverkit.test/login');
  });

  it('conserve la destination demandée', () => {
    const res = proxy(req('/app/cases/123?tab=timeline'));
    expect(res.headers.get('location')).toBe('https://app.recoverkit.test/login?next=%2Fapp%2Fcases%2F123%3Ftab%3Dtimeline');
  });

  it('mémorise la destination dans un cookie court pour la connexion', () => {
    const res = proxy(req('/app/cases/123?tab=timeline'));
    const c = res.headers.get('set-cookie')!;
    expect(c).toContain(`rk_next=${encodeURIComponent('/app/cases/123?tab=timeline')}`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=lax');
    expect(c).toMatch(/Max-Age=\d+/i);
  });

  it('laisse passer une requête avec cookie (la validité réelle est vérifiée côté serveur)', () => {
    const res = proxy(req('/app', 'rk_session=abc'));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('flash : copié dans un en-tête interne puis effacé (lecture unique)', () => {
    const res = proxy(req('/app/emails', 'rk_session=abc; rk_flash=%7B%22path%22%3A%22%C3%A9%22%7D'));
    expect(res.headers.get('x-middleware-request-x-rk-flash')).toBe('%7B%22path%22%3A%22%C3%A9%22%7D');
    const c = res.headers.get('set-cookie')!;
    expect(c).toContain('rk_flash=;');
    expect(c).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it('en-tête de flash forgé par le client : jamais transmis', () => {
    const r = new NextRequest('https://app.recoverkit.test/app/emails', { headers: { cookie: 'rk_session=abc', 'x-rk-flash': 'forged' } });
    const res = proxy(r);
    expect(res.headers.get('x-middleware-request-x-rk-flash')).toBeNull();
    expect(res.headers.get('x-middleware-override-headers') ?? '').not.toContain('x-rk-flash');
    expect(res.headers.get('x-middleware-override-headers')).toContain('cookie');
  });

  it('un cookie vide est traité comme absent', () => {
    expect(proxy(req('/app', 'rk_session=')).status).toBe(307);
  });

  it('ne s’applique qu’à /app', () => {
    expect(config.matcher).toEqual(['/app/:path*']);
  });
});
