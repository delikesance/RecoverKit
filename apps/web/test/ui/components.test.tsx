import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../../src/ui/AppShell';
import { AreaChart } from '../../src/ui/AreaChart';
import { Banners } from '../../src/ui/Banners';
import { CasesTable } from '../../src/ui/CasesTable';
import { Chip } from '../../src/ui/Chip';
import { Segments } from '../../src/ui/Segments';
import { Timeline } from '../../src/ui/Timeline';

const NOW = new Date('2026-10-28T10:00:00Z');

describe('Chip', () => {
  it('affiche le libellé avec la classe de ton', () => {
    render(<Chip tone="success">Récupéré</Chip>);
    expect(screen.getByText('Récupéré').className).toContain('chip-success');
  });
});

describe('Segments', () => {
  it('expose la progression à l’accessibilité', () => {
    render(<Segments sent={3} total={4} />);
    const el = screen.getByRole('img', { name: 'Email 3 sur 4 envoyé' });
    expect(el.querySelectorAll('i.f')).toHaveLength(3);
    expect(el.querySelectorAll('i')).toHaveLength(4);
  });
  it('aucun email : tous les segments vides', () => {
    render(<Segments sent={0} total={4} />);
    expect(screen.getByRole('img', { name: 'Aucun email envoyé' }).querySelectorAll('i.f')).toHaveLength(0);
  });
  it('rien à afficher sans étape prévue', () => {
    const { container } = render(<Segments sent={0} total={0} />);
    expect(container.querySelector('i')).toBeNull();
    expect(screen.getByRole('img', { name: 'Aucune relance prévue' })).toBeTruthy();
  });
});

describe('AreaChart', () => {
  const series = [
    { date: '2026-10-01', cumulative: 0 },
    { date: '2026-10-15', cumulative: 1000 },
    { date: '2026-10-28', cumulative: 2500 },
  ];
  it('rend un SVG décrit avec le total', () => {
    render(<AreaChart series={series} currency="EUR" />);
    const svg = screen.getByRole('img');
    expect(svg.getAttribute('aria-label')).toMatch(/25,00/);
    expect(svg.querySelectorAll('path')).toHaveLength(2);
  });
  it('affiche les dates de début et de fin', () => {
    render(<AreaChart series={series} currency="EUR" />);
    expect(screen.getByText('1 oct.')).toBeTruthy();
    expect(screen.getByText('28 oct.')).toBeTruthy();
  });
  it('message utile quand il n’y a encore rien', () => {
    render(<AreaChart series={[]} currency="EUR" />);
    expect(screen.getByText(/Aucun paiement récupéré/)).toBeTruthy();
  });
});

describe('Banners', () => {
  it('liste les alertes avec leur gravité et leur lien', () => {
    render(
      <Banners
        alerts={[
          { kind: 'stripe_revoked', severity: 'critical', message: 'La connexion Stripe a été révoquée.', href: '/app/settings' },
          { kind: 'last_notice', severity: 'warning', message: 'Camille reçoit son dernier avis.', href: '/app/cases/1' },
        ]}
      />,
    );
    const alerts = screen.getAllByRole('status', { hidden: true }).length + screen.getAllByRole('alert').length;
    expect(alerts).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('alert').textContent).toContain('révoquée');
    expect(screen.getByRole('link', { name: /Camille reçoit son dernier avis/ }).getAttribute('href')).toBe('/app/cases/1');
  });
  it('ne rend rien sans alerte', () => {
    const { container } = render(<Banners alerts={[]} />);
    expect(container.textContent).toBe('');
  });
});

describe('AppShell', () => {
  it('marque la page courante, affiche le nombre d’échecs et le statut Stripe', () => {
    render(
      <AppShell tenantName="Nimbus Notes" active="cases" activeCases={7} stripe="ACTIVE" userEmail="f@example.com">
        <p>Contenu</p>
      </AppShell>,
    );
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(within(nav).getByRole('link', { name: /Échecs en cours/ }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: /Tableau de bord/ }).getAttribute('aria-current')).toBeNull();
    expect(within(nav).getByText('7')).toBeTruthy();
    expect(screen.getByText('Stripe connecté')).toBeTruthy();
    expect(screen.getByText('Contenu')).toBeTruthy();
    expect(screen.getByText('Nimbus Notes')).toBeTruthy();
  });
  it('signale une connexion Stripe absente ou révoquée', () => {
    const { rerender } = render(<AppShell tenantName="N" active="dashboard" activeCases={0} stripe={null} userEmail="a@b.c"><p>x</p></AppShell>);
    expect(screen.getByText('Stripe non connecté')).toBeTruthy();
    rerender(<AppShell tenantName="N" active="dashboard" activeCases={0} stripe="REVOKED" userEmail="a@b.c"><p>x</p></AppShell>);
    expect(screen.getByText('Connexion Stripe révoquée')).toBeTruthy();
  });
  it('la déconnexion est un formulaire POST (pas un lien)', () => {
    render(<AppShell tenantName="N" active="dashboard" activeCases={0} stripe="ACTIVE" userEmail="a@b.c"><p>x</p></AppShell>);
    const btn = screen.getByRole('button', { name: 'Se déconnecter' });
    expect(btn.closest('form')!.getAttribute('method')).toBe('post');
    expect(btn.closest('form')!.getAttribute('action')).toBe('/api/auth/logout');
  });
  it('propose un lien d’évitement vers le contenu', () => {
    render(<AppShell tenantName="N" active="dashboard" activeCases={0} stripe="ACTIVE" userEmail="a@b.c"><p>x</p></AppShell>);
    expect(screen.getByRole('link', { name: 'Aller au contenu' }).getAttribute('href')).toBe('#contenu');
  });
});

describe('CasesTable', () => {
  const rows = [
    { id: 'c1', customerName: 'Camille Roux', customerEmail: 'c@example.com', amount: 7900, currency: 'EUR', state: 'RECOVERING', failureCode: 'card_declined', attemptCount: 2, failedAt: new Date('2026-10-17T08:00:00Z'), daysSinceFailure: 11, stepsSent: 3, stepsTotal: 4, nextDueAt: new Date('2026-10-29T07:00:00Z') },
    { id: 'c2', customerName: null, customerEmail: null, amount: 14900, currency: 'EUR', state: 'PAUSED', failureCode: null, attemptCount: 1, failedAt: new Date('2026-10-22T08:00:00Z'), daysSinceFailure: 6, stepsSent: 1, stepsTotal: 4, nextDueAt: null },
  ];
  it('affiche client, montant, progression, badge et lien vers le dossier', () => {
    render(<CasesTable rows={rows} now={NOW} timeZone="Europe/Paris" />);
    const table = screen.getByRole('table');
    expect(within(table).getByRole('link', { name: /Camille Roux/ }).getAttribute('href')).toBe('/app/cases/c1');
    expect(within(table).getByText(/79,00/)).toBeTruthy();
    expect(within(table).getByText('Dernier avis demain')).toBeTruthy();
    expect(within(table).getByText('En pause')).toBeTruthy();
    expect(within(table).getByText('Client inconnu')).toBeTruthy();
    expect(within(table).getByRole('img', { name: 'Email 3 sur 4 envoyé' })).toBeTruthy();
    expect(within(table).getByText(/il y a 11 jours · Carte refusée/)).toBeTruthy();
  });
  it('état vide : message utile', () => {
    render(<CasesTable rows={[]} now={NOW} timeZone="Europe/Paris" />);
    expect(screen.getByText(/Aucun paiement en cours de relance/)).toBeTruthy();
  });
  it('colonnes avec en-têtes', () => {
    render(<CasesTable rows={rows} now={NOW} timeZone="Europe/Paris" />);
    for (const h of ['Client', 'Montant', 'Relance', 'État', 'Prochaine étape']) expect(screen.getByRole('columnheader', { name: h })).toBeTruthy();
  });
});

describe('Timeline', () => {
  it('liste les événements dans l’ordre, du plus récent au plus ancien', () => {
    render(
      <Timeline
        timeZone="Europe/Paris"
        events={[
          { action: 'case.opened', actor: 'stripe', details: {}, at: new Date('2026-10-17T08:00:01Z') },
          { action: 'email.sent', actor: 'system', details: { stepIndex: 0 }, at: new Date('2026-10-17T09:00:00Z') },
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('Email 1 envoyé');
    expect(items[1]!.textContent).toContain('Échec de paiement détecté');
  });
  it('affiche les relances à venir en tête', () => {
    render(<Timeline timeZone="Europe/Paris" events={[]} upcoming={[{ label: 'Dernier avis planifié', at: new Date('2026-10-29T07:00:00Z') }]} />);
    expect(screen.getByText('Dernier avis planifié')).toBeTruthy();
  });
});
