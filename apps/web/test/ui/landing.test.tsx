import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Calculator } from '../../src/ui/marketing/Calculator';
import { LandingView } from '../../src/ui/marketing/LandingView';

const plans = [
  { key: 'start', name: 'Départ', priceId: 'p1', maxMrr: 500000, monthlyPrice: 2900 },
  { key: 'growth', name: 'Croissance', priceId: 'p2', maxMrr: 2000000, monthlyPrice: 5900 },
  { key: 'scale', name: 'Échelle', priceId: 'p3', maxMrr: null, monthlyPrice: 12900 },
];
const norm = (s: string | null) => (s ?? '').replace(/[  ]/g, ' ');

describe('Calculator', () => {
  it('affiche l’estimation par défaut', () => {
    render(<Calculator />);
    expect(norm(screen.getByTestId('year-total').textContent)).toBe('7 200 €');
    expect(norm(screen.getByTestId('month-lost').textContent)).toBe('1 200 €');
    expect(norm(screen.getByTestId('month-recovered').textContent)).toBe('600 €');
  });

  it('se met à jour quand on déplace les curseurs', () => {
    render(<Calculator />);
    fireEvent.change(screen.getByLabelText(/Revenu mensuel récurrent/), { target: { value: '50000' } });
    expect(norm(screen.getByTestId('year-total').textContent)).toBe('18 000 €');
    fireEvent.change(screen.getByLabelText(/Part des paiements qui échouent/), { target: { value: '10' } });
    expect(norm(screen.getByTestId('year-total').textContent)).toBe('30 000 €');
    fireEvent.change(screen.getByLabelText(/Part récupérée/), { target: { value: '20' } });
    expect(norm(screen.getByTestId('year-total').textContent)).toBe('12 000 €');
  });

  it('chaque curseur a une étiquette et affiche sa valeur', () => {
    render(<Calculator />);
    for (const name of [/Revenu mensuel récurrent/, /Part des paiements qui échouent/, /Part récupérée/]) {
      const input = screen.getByLabelText(name) as HTMLInputElement;
      expect(input.type).toBe('range');
    }
    expect(norm(screen.getByText(/6 %/).textContent)).toContain('6 %');
  });

  it('rappelle que c’est une estimation', () => {
    render(<Calculator />);
    expect(screen.getByText(/estimation/i)).toBeTruthy();
  });

  it('le résultat est annoncé aux lecteurs d’écran', () => {
    render(<Calculator />);
    expect(screen.getByTestId('year-total').closest('[aria-live]')?.getAttribute('aria-live')).toBe('polite');
  });
});

describe('LandingView', () => {
  it('titre principal et appels à l’action vers la connexion', () => {
    render(<LandingView plans={plans} trialDays={14} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('paiement refusé');
    const ctas = screen.getAllByRole('link', { name: /Connecter mon Stripe|Commencer/ });
    expect(ctas.length).toBeGreaterThanOrEqual(2);
    for (const a of ctas) expect(a.getAttribute('href')).toBe('/login');
  });

  it('présente le fonctionnement en trois étapes', () => {
    render(<LandingView plans={plans} trialDays={14} />);
    const section = screen.getByRole('region', { name: /Trois étapes/ });
    expect(within(section).getAllByRole('heading', { level: 3 })).toHaveLength(3);
  });

  it('affiche les tarifs issus de la configuration, sans prix codé en dur', () => {
    render(<LandingView plans={plans} trialDays={14} />);
    const section = screen.getByRole('region', { name: /tarif/i });
    expect(norm(section.textContent)).toContain('29,00 €');
    expect(norm(section.textContent)).toContain('59,00 €');
    expect(norm(section.textContent)).toContain('129,00 €');
    expect(section.textContent).toContain('14 jours');
  });

  it('sans paliers configurés : propose l’essai gratuit, sans prix inventé', () => {
    render(<LandingView plans={[]} trialDays={14} />);
    const section = screen.getByRole('region', { name: /tarif/i });
    expect(norm(section.textContent)).not.toMatch(/\d+,\d{2} €/);
    expect(section.textContent).toContain('14 jours');
  });

  it('aucun texte provisoire (crochets) dans la page', () => {
    const { container } = render(<LandingView plans={plans} trialDays={14} />);
    expect(container.textContent).not.toMatch(/\[[A-Za-zÀ-ÿ ]+\]/);
    expect(container.textContent).not.toMatch(/\bXX\b/);
  });

  it('la FAQ utilise des éléments natifs repliables et accessibles', () => {
    const { container } = render(<LandingView plans={plans} trialDays={14} />);
    const items = container.querySelectorAll('details');
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const d of items) expect(d.querySelector('summary')).not.toBeNull();
  });

  it('pied de page avec les pages légales', () => {
    render(<LandingView plans={plans} trialDays={14} />);
    expect(screen.getByRole('link', { name: 'Mentions légales' }).getAttribute('href')).toBe('/mentions-legales');
    expect(screen.getByRole('link', { name: 'Confidentialité' }).getAttribute('href')).toBe('/confidentialite');
  });

  it('chaque page n’a qu’un seul titre de niveau 1 et une navigation nommée', () => {
    render(<LandingView plans={plans} trialDays={14} />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('navigation', { name: 'Principal' })).toBeTruthy();
  });
});
