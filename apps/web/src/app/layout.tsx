import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? 'http://localhost:3000'),
  title: { default: 'RecoverKit, récupération des paiements Stripe échoués', template: '%s | RecoverKit' },
  description: 'RecoverKit relance vos clients dont le paiement Stripe a échoué et vous montre chaque euro récupéré.',
  openGraph: { title: 'RecoverKit', description: 'Récupérez les abonnements perdus à cause d’un paiement refusé.', type: 'website', locale: 'fr_FR' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#2557e8' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
