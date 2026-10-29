import { hitRateLimit } from '@recoverkit/db';
import { exportRecoveredCsv, exportTenantData, type Deps } from '@recoverkit/services';
import { jsonResponse, sessionOf } from '../http';

const NO_STORE = 'no-store, max-age=0';
const EXPORT_LIMIT = { limit: 5, windowSeconds: 3600 };
/** Export CSV mensuel : plus léger et légitimement répété (filtre par devise, mois), mais borné par tenant. */
const EXPORT_CSV_LIMIT = { limit: 30, windowSeconds: 3600 };

/** Découpe un bloc CSV (enregistrements complets, séparateur « ; ») en enregistrements, en respectant les guillemets. */
function splitRecords(chunk: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === '\n' && !quoted) {
      out.push(chunk.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < chunk.length) out.push(chunk.slice(start));
  return out;
}

/** 6e colonne (Devise) d'un enregistrement ; les colonnes précédentes peuvent contenir des guillemets. */
function currencyOf(record: string): string {
  let col = 0;
  let quoted = false;
  let from = 0;
  for (let i = 0; i < record.length; i++) {
    const ch = record[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ';' && !quoted) {
      if (col === 5) return record.slice(from, i);
      col++;
      from = i + 1;
    }
  }
  return '';
}

export async function handleExportRecovered(deps: Deps, req: Request): Promise<Response> {
  const session = await sessionOf(deps, req);
  if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
  const hit = await hitRateLimit(deps.pool, `export:recovered:${session.tenantId}`, EXPORT_CSV_LIMIT, deps.clock.now());
  if (!hit.allowed) return jsonResponse({ error: 'rate_limited' }, 429, { 'retry-after': '3600' });
  const q = new URL(req.url).searchParams;
  const now = deps.clock.now();
  const year = Number(q.get('year') ?? now.getUTCFullYear());
  const month = Number(q.get('month') ?? now.getUTCMonth() + 1);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    return jsonResponse({ error: 'invalid_period' }, 400);
  }
  const rawCurrency = q.get('currency');
  const currency = rawCurrency ? rawCurrency.toUpperCase() : null;
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) return jsonResponse({ error: 'invalid_currency' }, 400);
  const iterator = exportRecoveredCsv(deps, session.tenantId, { year, month })[Symbol.asyncIterator]();
  let first = true;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else if (currency === null) controller.enqueue(encoder.encode(value));
      else {
        // Le premier bloc est l'en-tête (toujours conservé) ; ensuite seules les lignes de la devise demandée.
        const kept = splitRecords(value).filter((rec, i) => (first && i === 0) || currencyOf(rec) === currency);
        first = false;
        controller.enqueue(encoder.encode(kept.join('')));
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="recoverkit-recuperes-${year}-${String(month).padStart(2, '0')}${currency ? `-${currency}` : ''}.csv"`,
      'cache-control': NO_STORE,
    },
  });
}

export async function handleExportData(deps: Deps, req: Request): Promise<Response> {
  const session = await sessionOf(deps, req);
  if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
  const hit = await hitRateLimit(deps.pool, `export:data:${session.userId}`, EXPORT_LIMIT, deps.clock.now());
  if (!hit.allowed) return jsonResponse({ error: 'rate_limited' }, 429, { 'retry-after': '3600' });
  const data = await exportTenantData(deps, session.tenantId, { actor: `user:${session.userId}` });
  const day = deps.clock.now().toISOString().slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="recoverkit-donnees-${day}.json"`,
      'cache-control': NO_STORE,
    },
  });
}
