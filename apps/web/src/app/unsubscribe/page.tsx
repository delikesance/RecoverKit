import type { Metadata } from 'next';
import { verifyUnsubscribe } from '@recoverkit/core';
import { getDeps } from '@/server/runtime';

export const metadata: Metadata = { title: 'Ne plus recevoir ces relances', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ t?: string; e?: string; s?: string; done?: string; error?: string }> }) {
  const sp = await searchParams;
  const deps = getDeps();
  let valid = false;
  let tenantName: string | null = null;
  if (sp.t && sp.e && sp.s) {
    const email = Buffer.from(sp.e, 'base64url').toString('utf8');
    valid = verifyUnsubscribe(deps.config.tokenSecret, sp.t, email, sp.s);
    if (valid) tenantName = (await deps.pool.query(`select name from tenants where id = $1`, [sp.t])).rows[0]?.name ?? null;
  }
  const query = new URLSearchParams({ t: sp.t ?? '', e: sp.e ?? '', s: sp.s ?? '' }).toString();
  return (
    <div className="auth-wrap">
      <div className="panel auth-card">
        {sp.done ? (
          <>
            <h1 className="page-title" style={{ fontSize: 28 }}>C’est noté.</h1>
            <p className="muted" style={{ marginTop: 12 }}>Vous ne recevrez plus ces relances de paiement. Votre abonnement n’est pas modifié : pensez à mettre votre carte à jour pour le conserver.</p>
          </>
        ) : valid ? (
          <>
            <h1 className="page-title" style={{ fontSize: 28 }}>Ne plus recevoir ces relances ?</h1>
            <p className="muted" style={{ marginTop: 12 }}>Vous n’entendrez plus parler de ce paiement de la part de {tenantName ?? 'votre fournisseur'}. Votre abonnement, lui, n’est pas annulé.</p>
            <form method="post" action={`/api/unsubscribe?${query}`} style={{ marginTop: 24 }}>
              <button type="submit" className="btn btn-p btn-lg" style={{ width: '100%' }}>Ne plus recevoir ces relances</button>
            </form>
          </>
        ) : (
          <>
            <h1 className="page-title" style={{ fontSize: 28 }}>Ce lien n’est plus valide.</h1>
            <p className="muted" style={{ marginTop: 12 }}>Répondez directement à l’email que vous avez reçu pour nous demander d’arrêter les relances.</p>
          </>
        )}
      </div>
    </div>
  );
}
