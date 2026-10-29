import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mount = vi.fn();
const confirmSetup = vi.fn();
vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn(async () => ({
    elements: () => ({ create: () => ({ mount }) }),
    confirmSetup,
  })),
}));

import { PayForm } from '../../src/ui/pay/PayForm';

const base = { token: 'tok', locale: 'fr' as const, amount: '29,00 €', tenantName: 'Nimbus', publishableKey: 'pk_live_x', account: 'acct_1' };

function setupResponse(ok: boolean) {
  return { ok, json: async () => ({ publishableKey: 'pk', account: 'acct_1', clientSecret: 'seti_secret' }) } as Response;
}

beforeEach(() => {
  mount.mockReset();
  confirmSetup.mockReset();
  vi.unstubAllGlobals();
});

describe('PayForm', () => {
  it('pendant le chargement de Stripe : message de chargement et bouton inactif', async () => {
    let release!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { release = r; })));
    render(<PayForm {...base} />);
    const btn = screen.getByRole('button', { name: /Mettre à jour et payer/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText('Chargement du formulaire sécurisé…')).toBeTruthy();
    release(setupResponse(true));
    await waitFor(() => expect((screen.getByRole('button', { name: /Mettre à jour et payer/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('Chargement du formulaire sécurisé…')).toBeNull();
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it('échec de préparation : erreur claire et bouton « Réessayer » qui relance le chargement', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(setupResponse(false)).mockResolvedValueOnce(setupResponse(true));
    vi.stubGlobal('fetch', fetchMock);
    render(<PayForm {...base} />);
    const retry = await screen.findByRole('button', { name: 'Réessayer' });
    expect((screen.getByRole('button', { name: /Mettre à jour et payer/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(retry);
    await waitFor(() => expect((screen.getByRole('button', { name: /Mettre à jour et payer/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('le champ carte est nommé par son libellé (pas de label orphelin)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => setupResponse(true)));
    const { container } = render(<PayForm {...base} />);
    await waitFor(() => expect(mount).toHaveBeenCalled());
    const group = screen.getByRole('group', { name: 'Carte bancaire' });
    expect(group).toBeTruthy();
    expect(container.querySelector('label[for]')).toBeNull();
  });

  it('en mode simulé : prêt tout de suite, libellé relié au champ', () => {
    render(<PayForm {...base} publishableKey="pk_fake_e2e" />);
    expect((screen.getByRole('button', { name: /Mettre à jour et payer/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByLabelText('Numéro de carte (mode test)')).toBeTruthy();
  });

  it('confirmSetup sans erreur : le bouton reste occupé pendant la redirection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => setupResponse(true)));
    confirmSetup.mockResolvedValue({});
    render(<PayForm {...base} />);
    await waitFor(() => expect((screen.getByRole('button', { name: /Mettre à jour et payer/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Mettre à jour et payer/ }));
    await waitFor(() => expect(confirmSetup).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByRole('button').textContent).toBe('Traitement…');
  });

  it('confirmSetup en erreur : message de Stripe et bouton de nouveau actif', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => setupResponse(true)));
    confirmSetup.mockResolvedValue({ error: { message: 'Carte refusée' } });
    render(<PayForm {...base} />);
    await waitFor(() => expect((screen.getByRole('button', { name: /Mettre à jour et payer/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Mettre à jour et payer/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Carte refusée');
    await waitFor(() => expect((screen.getByRole('button', { name: /Mettre à jour et payer/ }) as HTMLButtonElement).disabled).toBe(false));
  });
});
