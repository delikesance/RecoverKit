import { describe, expect, it } from 'vitest';
import { securityHeaders } from '../src/server/security-headers';

type Rule = { source: string; headers: { key: string; value: string }[] };
const rules = securityHeaders() as Rule[];
const headersFor = (source: string) => Object.fromEntries(rules.find((r) => r.source === source)!.headers.map((h) => [h.key, h.value]));
const all = () => headersFor('/:path*');

describe('en-têtes de sécurité', () => {
  it('toutes les routes : nosniff, pas d’iframe, politique de référent, permissions réduites', () => {
    const h = all();
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Permissions-Policy']).toContain('camera=()');
    expect(h['Permissions-Policy']).toContain('geolocation=()');
  });

  it('HSTS d’un an avec sous-domaines', () => {
    expect(all()['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('CSP : sources limitées, Stripe autorisé uniquement là où il sert, pas d’objet ni de base arbitraire', () => {
    const csp = all()['Content-Security-Policy']!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toMatch(/\*\s*[;']/); // jamais de joker nu
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('page de paiement client : jamais de cache, pas d’indexation, aucun référent, Stripe.js autorisé', () => {
    const h = headersFor('/pay/:path*');
    expect(h['Cache-Control']).toBe('no-store, max-age=0');
    expect(h['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(h['Referrer-Policy']).toBe('same-origin');
    expect(h['Content-Security-Policy']).toContain('https://js.stripe.com');
    expect(h['Content-Security-Policy']).toContain('frame-src https://js.stripe.com https://hooks.stripe.com');
  });

  it('espace fondateur : jamais de cache ni d’indexation', () => {
    const h = headersFor('/app/:path*');
    expect(h['Cache-Control']).toBe('no-store, max-age=0');
    expect(h['X-Robots-Tag']).toBe('noindex, nofollow');
  });

  it('API : jamais de cache', () => {
    expect(headersFor('/api/:path*')['Cache-Control']).toBe('no-store, max-age=0');
  });

  it('connexion et désinscription : pas d’indexation, pas de référent', () => {
    for (const source of ['/login', '/auth/:path*', '/unsubscribe']) {
      const h = headersFor(source);
      expect(h['X-Robots-Tag'], source).toBe('noindex, nofollow');
      expect(h['Referrer-Policy'], source).toBe('same-origin');
    }
  });
});
