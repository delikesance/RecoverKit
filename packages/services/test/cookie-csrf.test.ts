import { describe, expect, it } from 'vitest';
import { checkCsrf, serializeSessionCookie, SESSION_COOKIE } from '../src/auth/http';

describe('cookie de session', () => {
  it('HttpOnly, Secure, SameSite=Lax, Path=/, durée 30 jours', () => {
    const c = serializeSessionCookie('tok', { secure: true });
    expect(c).toContain(`${SESSION_COOKIE}=tok`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c).toContain(`Max-Age=${30 * 24 * 3600}`);
  });

  it('hors production le cookie peut ne pas être Secure', () => {
    expect(serializeSessionCookie('tok', { secure: false })).not.toContain('Secure');
  });

  it('un cookie de déconnexion expire immédiatement', () => {
    const c = serializeSessionCookie('', { secure: true, clear: true });
    expect(c).toContain('Max-Age=0');
  });
});

describe('checkCsrf', () => {
  const appUrl = 'https://app.recoverkit.example';
  it('laisse passer les méthodes sûres', () => {
    expect(checkCsrf({ method: 'GET', origin: 'https://evil.example', appUrl })).toBe(true);
    expect(checkCsrf({ method: 'HEAD', origin: null, appUrl })).toBe(true);
  });
  it('accepte une requête mutante de la même origine', () => {
    expect(checkCsrf({ method: 'POST', origin: appUrl, appUrl })).toBe(true);
  });
  it('refuse une origine différente', () => {
    expect(checkCsrf({ method: 'POST', origin: 'https://evil.example', appUrl })).toBe(false);
    expect(checkCsrf({ method: 'DELETE', origin: 'https://app.recoverkit.example.evil.com', appUrl })).toBe(false);
  });
  it('se rabat sur le Referer, refuse sans origine ni referer', () => {
    expect(checkCsrf({ method: 'POST', origin: null, referer: `${appUrl}/app/settings`, appUrl })).toBe(true);
    expect(checkCsrf({ method: 'POST', origin: null, referer: 'https://evil.example/x', appUrl })).toBe(false);
    expect(checkCsrf({ method: 'POST', origin: null, appUrl })).toBe(false);
  });
});
