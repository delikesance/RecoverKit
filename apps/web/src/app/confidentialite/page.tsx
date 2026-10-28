import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Politique de confidentialité' };

export default function Privacy() {
  return (
    <main className="auth-wrap">
      <article className="panel" style={{ maxWidth: 680, padding: 32 }}>
        <h1 className="page-title" style={{ fontSize: 28 }}>Politique de confidentialité</h1>
        <h2 style={{ marginTop: 24, fontSize: 18 }}>Données que nous traitons</h2>
        <p className="muted" style={{ marginTop: 8 }}>
          Pour le compte des fondateurs qui utilisent RecoverKit, nous conservons un instantané minimal de leurs clients finaux : adresse email, nom, langue, ainsi que le montant et l’état de la facture impayée. Nous ne stockons jamais de numéro de carte : la saisie est faite directement chez Stripe.
        </p>
        <h2 style={{ marginTop: 24, fontSize: 18 }}>Durée de conservation</h2>
        <p className="muted" style={{ marginTop: 8 }}>Les données des clients finaux sont effacées 18 mois après la clôture du dossier. Le journal comptable du revenu récupéré est conservé sous forme anonymisée.</p>
        <h2 style={{ marginTop: 24, fontSize: 18 }}>Vos droits</h2>
        <p className="muted" style={{ marginTop: 8 }}>Les fondateurs peuvent exporter ou supprimer l’ensemble de leurs données depuis les réglages. Un client final peut se désinscrire des relances via le lien présent dans chaque email, ou en demandant l’effacement à son fournisseur.</p>
        <p style={{ marginTop: 24 }}><a href="/">Retour à l’accueil</a></p>
      </article>
    </main>
  );
}
