import type { ReactNode } from 'react';
import { IconAlert, IconCard, IconCheck, IconDashboard, IconList, IconMail, IconSettings, LogoMark } from './icons';

export type NavKey = 'dashboard' | 'cases' | 'recovered' | 'sequence' | 'emails' | 'settings' | 'billing';

const NAV: { key: NavKey; href: string; label: string; icon: ReactNode }[] = [
  { key: 'dashboard', href: '/app', label: 'Tableau de bord', icon: <IconDashboard /> },
  { key: 'cases', href: '/app/cases', label: 'Échecs en cours', icon: <IconAlert /> },
  { key: 'recovered', href: '/app/recovered', label: 'Récupérés', icon: <IconCheck /> },
  { key: 'sequence', href: '/app/sequence', label: 'Séquence de relance', icon: <IconList /> },
  { key: 'emails', href: '/app/emails', label: 'Emails', icon: <IconMail /> },
  { key: 'billing', href: '/app/billing', label: 'Abonnement', icon: <IconCard /> },
  { key: 'settings', href: '/app/settings', label: 'Réglages', icon: <IconSettings /> },
];

export function AppShell({
  tenantName,
  active,
  activeCases,
  stripe,
  userEmail,
  children,
}: {
  tenantName: string;
  active: NavKey;
  activeCases: number;
  stripe: 'PENDING' | 'ACTIVE' | 'REVOKED' | null;
  userEmail: string;
  children: ReactNode;
}) {
  const stripeOk = stripe === 'ACTIVE';
  const stripeLabel = stripeOk ? 'Stripe connecté' : stripe === 'REVOKED' ? 'Connexion Stripe révoquée' : 'Stripe non connecté';
  return (
    <div className="app">
      <a href="#contenu" className="skip-link">Aller au contenu</a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><LogoMark /></span>
          RecoverKit
        </div>
        <nav aria-label="Principal" className="stack" style={{ gap: 4 }}>
          {NAV.map((n) => (
            <a key={n.key} href={n.href} className="nav-link" aria-current={n.key === active ? 'page' : undefined}>
              {n.icon}
              <span className="grow">{n.label}</span>
              {n.key === 'cases' && activeCases > 0 ? <span className="chip chip-warning" style={{ height: 24, padding: '0 9px' }}>{activeCases}</span> : null}
            </a>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <div className="status-box">
          <b><span className={stripeOk ? 'dot' : 'dot dot-bad'} />{stripeLabel}</b>
          {stripeOk ? 'Les paiements échoués sont détectés automatiquement.' : 'Connectez Stripe pour activer les relances.'}
        </div>
        <div className="row tenant" style={{ gap: 10, padding: '14px 8px 0' }}>
          <span className="av" style={{ background: 'var(--blue-tint)', color: 'var(--blue-hover)' }}>{tenantName.slice(0, 1).toUpperCase()}</span>
          <span style={{ fontSize: 14, fontWeight: 600, minWidth: 0 }}>
            <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tenantName}</span>
            <span className="muted" style={{ fontSize: 12, fontWeight: 400, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{userEmail}</span>
          </span>
        </div>
        <form method="post" action="/api/auth/logout" style={{ padding: '8px 4px 0' }}>
          <button type="submit" className="btn btn-s btn-sm" style={{ width: '100%' }}>Se déconnecter</button>
        </form>
      </aside>
      <main id="contenu" className="main" tabIndex={-1}>{children}</main>
    </div>
  );
}
