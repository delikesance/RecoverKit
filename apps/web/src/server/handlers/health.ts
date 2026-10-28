import { timingSafeEqual } from 'node:crypto';
import { getHealthDetails, type Deps } from '@recoverkit/services';
import { jsonResponse } from '../http';

export async function handleHealth(deps: Deps): Promise<Response> {
  try {
    await deps.pool.query('select 1');
    return jsonResponse({ status: 'ok' });
  } catch {
    return jsonResponse({ status: 'down' }, 503);
  }
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Indicateurs d'exploitation : réservés au jeton d'administration ; la route n'existe pas s'il n'est pas configuré. */
export async function handleHealthDetails(deps: Deps, req: Request): Promise<Response> {
  const expected = deps.config.adminToken;
  if (!expected) return jsonResponse({ error: 'not_found' }, 404);
  const header = req.headers.get('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!given || !sameSecret(given, expected)) return jsonResponse({ error: 'unauthorized' }, 401);
  const details = await getHealthDetails(deps);
  return jsonResponse(details, details.status === 'down' ? 503 : 200);
}
