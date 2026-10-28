import { exportRecoveredCsv, exportTenantData, type Deps } from '@recoverkit/services';
import { jsonResponse, sessionOf } from '../http';

const NO_STORE = 'no-store, max-age=0';

export async function handleExportRecovered(deps: Deps, req: Request): Promise<Response> {
  const session = await sessionOf(deps, req);
  if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
  const q = new URL(req.url).searchParams;
  const now = deps.clock.now();
  const year = Number(q.get('year') ?? now.getUTCFullYear());
  const month = Number(q.get('month') ?? now.getUTCMonth() + 1);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    return jsonResponse({ error: 'invalid_period' }, 400);
  }
  const iterator = exportRecoveredCsv(deps, session.tenantId, { year, month })[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="recoverkit-recuperes-${year}-${String(month).padStart(2, '0')}.csv"`,
      'cache-control': NO_STORE,
    },
  });
}

export async function handleExportData(deps: Deps, req: Request): Promise<Response> {
  const session = await sessionOf(deps, req);
  if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
  const data = await exportTenantData(deps, session.tenantId);
  const day = deps.clock.now().toISOString().slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="recoverkit-donnees-${day}.json"`,
      'cache-control': NO_STORE,
    },
  });
}
