import type { Metadata } from 'next';
import { LogoMark } from '@/ui/icons';

export const metadata: Metadata = { title: 'Confirmer la connexion' };
export const dynamic = 'force-dynamic';

/** La page de confirmation évite qu'un scanner d'emails consomme le lien : seul le clic sur le bouton le fait. */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <div className="auth-wrap">
      <div className="panel auth-card">
        <div className="brand" style={{ padding: 0, marginBottom: 24 }}><span className="brand-mark"><LogoMark /></span> RecoverKit</div>
        {token ? (
          <>
            <h1 className="page-title" style={{ fontSize: 28 }}>Confirmer la connexion</h1>
            <p className="muted" style={{ marginTop: 8 }}>Un clic et vous êtes dans votre espace.</p>
            <form method="post" action="/api/auth/consume" style={{ marginTop: 24 }}>
              <input type="hidden" name="token" value={token} />
              <button type="submit" className="btn btn-p btn-lg" style={{ width: '100%' }}>Me connecter</button>
            </form>
          </>
        ) : (
          <>
            <h1 className="page-title" style={{ fontSize: 28 }}>Lien incomplet</h1>
            <p className="muted" style={{ marginTop: 8 }}>Ce lien est incomplet. Demandez-en un nouveau depuis la page de connexion.</p>
            <a href="/login" className="btn btn-p" style={{ marginTop: 24 }}>Retour à la connexion</a>
          </>
        )}
      </div>
    </div>
  );
}
