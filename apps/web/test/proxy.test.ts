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

  it('laisse passer une requête avec cookie (la validité réelle est vérifiée côté serveur)', () => {
    const res = proxy(req('/app', 'rk_session=abc'));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('un cookie vide est traité comme absent', () => {
    expect(proxy(req('/app', 'rk_session=')).status).toBe(307);
  });

  it('ne s’applique qu’à /app', () => {
    expect(config.matcher).toEqual(['/app/:path*']);
  });
});
