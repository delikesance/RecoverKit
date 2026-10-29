import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

// APP_URL est lu à la requête et non au build : l'image Docker est construite sans configuration.
export const dynamic = 'force-dynamic';

const baseMetadata: Metadata = {
  title: { default: 'RecoverKit, récupération des paiements Stripe échoués', template: '%s | RecoverKit' },
  description: 'RecoverKit relance vos clients dont le paiement Stripe a échoué et vous montre chaque euro récupéré.',
  openGraph: { title: 'RecoverKit', description: 'Récupérez les abonnements perdus à cause d’un paiement refusé.', type: 'website', locale: 'fr_FR' },
};

export function generateMetadata(): Metadata {
  return { ...baseMetadata, metadataBase: new URL(process.env.APP_URL ?? 'http://localhost:3000') };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#2557e8' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
