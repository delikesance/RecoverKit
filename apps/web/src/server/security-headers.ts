interface Rule {
  source: string;
  headers: { key: string; value: string }[];
}

const NO_STORE = 'no-store, max-age=0';
const NO_INDEX = 'noindex, nofollow';

// Next.js injecte des scripts et styles inline pour l'hydratation : 'unsafe-inline' reste nécessaire sans nonce.
// Aucun 'unsafe-eval', aucun joker, aucun objet, aucune base ni formulaire externes.
const CSP_BASE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

const CSP_PAY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://js.stripe.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.stripe.com",
  "font-src 'self' data:",
  "connect-src 'self' https://api.stripe.com https://m.stripe.network https://r.stripe.com",
  'frame-src https://js.stripe.com https://hooks.stripe.com',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

const h = (key: string, value: string) => ({ key, value });

/** Du plus général au plus précis : en cas de doublon, la dernière règle gagne (Next.js). */
export function securityHeaders(): Rule[] {
  return [
    {
      source: '/:path*',
      headers: [
        h('X-Content-Type-Options', 'nosniff'),
        h('X-Frame-Options', 'DENY'),
        h('Referrer-Policy', 'strict-origin-when-cross-origin'),
        h('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://js.stripe.com")'),
        h('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'),
        h('Content-Security-Policy', CSP_BASE.join('; ')),
      ],
    },
    { source: '/api/:path*', headers: [h('Cache-Control', NO_STORE)] },
    { source: '/app/:path*', headers: [h('Cache-Control', NO_STORE), h('X-Robots-Tag', NO_INDEX)] },
    // 'same-origin' et non 'no-referrer' : avec no-referrer le navigateur envoie « Origin: null » sur les POST,
    // ce que la vérification CSRF refuse. Rien ne fuit vers un autre site dans les deux cas.
    { source: '/login', headers: [h('X-Robots-Tag', NO_INDEX), h('Referrer-Policy', 'same-origin')] },
    { source: '/auth/:path*', headers: [h('Cache-Control', NO_STORE), h('X-Robots-Tag', NO_INDEX), h('Referrer-Policy', 'same-origin')] },
    { source: '/unsubscribe', headers: [h('Cache-Control', NO_STORE), h('X-Robots-Tag', NO_INDEX), h('Referrer-Policy', 'same-origin')] },
    {
      source: '/pay/:path*',
      headers: [
        h('Cache-Control', NO_STORE),
        h('X-Robots-Tag', NO_INDEX),
        h('Referrer-Policy', 'same-origin'),
        h('Content-Security-Policy', CSP_PAY.join('; ')),
      ],
    },
  ];
}
