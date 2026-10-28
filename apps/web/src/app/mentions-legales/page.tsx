import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Mentions légales' };

export default function Legal() {
  return (
    <main className="auth-wrap">
      <article className="panel" style={{ maxWidth: 680, padding: 32 }}>
        <h1 className="page-title" style={{ fontSize: 28 }}>Mentions légales</h1>
        <p className="muted" style={{ marginTop: 12 }}>
          Éditeur du service RecoverKit : les informations d’identification de la société (dénomination, adresse, numéro d’immatriculation, directeur de la publication) sont à renseigner par l’exploitant avant la mise en production, dans ce fichier.
        </p>
        <h2 style={{ marginTop: 24, fontSize: 18 }}>Hébergement</h2>
        <p className="muted" style={{ marginTop: 8 }}>L’hébergeur est indiqué par l’exploitant lors du déploiement.</p>
        <h2 style={{ marginTop: 24, fontSize: 18 }}>Contact</h2>
        <p className="muted" style={{ marginTop: 8 }}>Pour toute question, utilisez l’adresse de support communiquée dans vos emails de connexion.</p>
        <p style={{ marginTop: 24 }}><a href="/">Retour à l’accueil</a></p>
      </article>
    </main>
  );
}
