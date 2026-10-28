import { timingSafeEqual } from 'node:crypto';

/** Les routes /api/e2e/* n'existent qu'en mode E2E et exigent le jeton de test. */
export function e2eAllowed(env: Record<string, string | undefined>, req: Request): boolean {
  if (env.RECOVERKIT_E2E !== '1') return false;
  const expected = env.E2E_TOKEN;
  const given = req.headers.get('x-e2e-token');
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
