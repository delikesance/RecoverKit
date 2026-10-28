import type { Metadata } from 'next';
import { LogoMark } from '@/ui/icons';

export const metadata: Metadata = { title: 'Connexion' };
export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  invalid: 'Cette adresse email n’est pas valide.',
  rate_limited: 'Trop de demandes. Réessayez dans une heure.',
  link: 'Ce lien n’est plus valide. Demandez-en un nouveau.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <div className="auth-wrap">
      <div className="panel auth-card">
        <div className="brand" style={{ padding: 0, marginBottom: 24 }}>
          <span className="brand-mark"><LogoMark /></span> RecoverKit
        </div>
        {sp.sent ? (
          <>
            <h1 className="page-title" style={{ fontSize: 28 }}>Vérifiez votre boîte mail</h1>
            <p className="muted" style={{ marginTop: 12 }}>Si cette adresse peut se connecter, vous allez recevoir un lien valable 15 minutes. Il ne fonctionne qu’une fois.</p>
            <a href="/login" className="btn btn-s" style={{ marginTop: 24 }}>Utiliser une autre adresse</a>
          </>
        ) : (
          <>
            <h1 className="page-title" style={{ fontSize: 28 }}>Se connecter</h1>
            <p className="muted" style={{ marginTop: 8 }}>Entrez votre adresse email : nous vous envoyons un lien de connexion. Aucun mot de passe à retenir.</p>
            {sp.error && ERRORS[sp.error] ? <div className="banner banner-critical" role="alert" style={{ marginTop: 16 }}><span className="grow">{ERRORS[sp.error]}</span></div> : null}
            <form method="post" action="/api/auth/login" style={{ marginTop: 24 }}>
              <label htmlFor="email" className="label">Adresse email</label>
              <input id="email" name="email" type="email" required autoComplete="email" inputMode="email" className="field" placeholder="vous@entreprise.com" />
              <button type="submit" className="btn btn-p btn-lg" style={{ width: '100%', marginTop: 16 }}>Recevoir mon lien</button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
