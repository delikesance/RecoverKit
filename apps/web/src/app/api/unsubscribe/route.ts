import { handleUnsubscribe } from '@/server/handlers/unsubscribe';
import { getDeps } from '@/server/runtime';

export const dynamic = 'force-dynamic';

// Lien de l'email : on affiche d'abord une page de confirmation (pas d'effet de bord sur un GET).
export function GET(req: Request) {
  const url = new URL(req.url);
  return new Response(null, { status: 303, headers: { location: `${getDeps().config.appUrl}/unsubscribe${url.search}` } });
}
export const POST = (req: Request) => handleUnsubscribe(getDeps(), req);
