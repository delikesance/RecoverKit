import type { ReactNode } from 'react';
import type { LegalConfig } from '@recoverkit/services';

const PENDING = 'Informations en cours de publication.';

function Value({ children }: { children: ReactNode | null | undefined }) {
  return <>{children || PENDING}</>;
}

function Mail({ address }: { address: string | null }) {
  return address ? <a href={`mailto:${address}`}>{address}</a> : <>{PENDING}</>;
}

export function LegalNotice({ legal }: { legal: LegalConfig }) {
  return (
    <main className="auth-wrap">
      <article className="panel" style={{ maxWidth: 680, padding: 32 }}>
        <h1 className="page-title" style={{ fontSize: 28 }}>Mentions légales</h1>
        <h2 style={{ marginTop: 24, fontSize: 18 }}>Éditeur du service RecoverKit</h2>
        <p className="muted" style={{ marginTop: 8 }}>Dénomination : <Value>{legal.companyName}</Value></p>
        <p className="muted" style={{ marginTop: 4 }}>Adresse : <Value>{legal.address}</Value></p>
        <p className="muted" style={{ marginTop: 4 }}>Directeur de la publication : <Value>{legal.publisher}</Value></p>
        <h2 style={{ marginTop: 24, fontSize: 18 }}>Hébergement</h2>
        <p className="muted" style={{ marginTop: 8 }}>Hébergeur : <Value>{legal.hostName}</Value></p>
        <p className="muted" style={{ marginTop: 4 }}>Adresse : <Value>{legal.hostAddress}</Value></p>
        <h2 style={{ marginTop: 24, fontSize: 18 }}>Contact</h2>
        <p className="muted" style={{ marginTop: 8 }}>Pour toute question : <Mail address={legal.contactEmail} /></p>
        <p style={{ marginTop: 24 }}><a href="/">Retour à l’accueil</a></p>
      </article>
    </main>
  );
}

export function PrivacyNotice({ legal }: { legal: LegalConfig }) {
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
        <h2 style={{ marginTop: 24, fontSize: 18 }}>Responsable du traitement et contact</h2>
        <p className="muted" style={{ marginTop: 8 }}>
          Responsable : <Value>{legal.companyName}</Value>. Pour exercer vos droits ou poser une question sur vos données : <Mail address={legal.dpoEmail ?? legal.contactEmail} />
        </p>
        <p style={{ marginTop: 24 }}><a href="/">Retour à l’accueil</a></p>
      </article>
    </main>
  );
}
