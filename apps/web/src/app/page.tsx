import type { Metadata } from 'next';
import { LandingView } from '@/ui/marketing/LandingView';
import { getDeps } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'RecoverKit — Récupérez les paiements Stripe refusés',
  description: 'RecoverKit relance automatiquement les clients dont le paiement d’abonnement Stripe a échoué, et mesure précisément le revenu récupéré.',
  openGraph: { title: 'RecoverKit', description: 'Récupérez les abonnements perdus à cause d’un paiement refusé.', type: 'website', locale: 'fr_FR' },
};

export default function HomePage() {
  const { config } = getDeps();
  return <LandingView plans={config.plans} trialDays={config.trialDays} />;
}
