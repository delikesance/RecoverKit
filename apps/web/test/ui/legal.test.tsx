import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LegalConfig } from '@recoverkit/services';
import { LegalNotice, PrivacyNotice } from '../../src/ui/legal/Legal';

const full: LegalConfig = {
  companyName: 'Acme SAS',
  address: '1 rue de la Paix, 75002 Paris',
  publisher: 'Jeanne Martin',
  hostName: 'Hébergeur SA',
  hostAddress: '2 avenue du Cloud, 69000 Lyon',
  contactEmail: 'contact@acme.example',
  dpoEmail: 'dpo@acme.example',
};
const empty: LegalConfig = { companyName: null, address: null, publisher: null, hostName: null, hostAddress: null, contactEmail: null, dpoEmail: null };
// Formulations de consigne à l'exploitant : interdites sur une page publique.
const OPERATOR_HINTS = /exploitant|dans ce fichier|à renseigner|lors du déploiement|variable|LEGAL_|mise en production/i;

describe('Mentions légales', () => {
  it('affiche l’éditeur, l’hébergeur et le contact issus de la configuration', () => {
    const { container, getByRole } = render(<LegalNotice legal={full} />);
    const text = container.textContent ?? '';
    for (const v of ['Acme SAS', '1 rue de la Paix', 'Jeanne Martin', 'Hébergeur SA', '2 avenue du Cloud', 'contact@acme.example']) expect(text).toContain(v);
    expect(getByRole('link', { name: 'contact@acme.example' }).getAttribute('href')).toBe('mailto:contact@acme.example');
    expect(text).not.toMatch(OPERATOR_HINTS);
  });

  it('sans valeur : « Informations en cours de publication », jamais de consigne développeur', () => {
    const { container } = render(<LegalNotice legal={empty} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Informations en cours de publication');
    expect(text).not.toMatch(OPERATOR_HINTS);
  });

  it('une valeur partielle n’affiche le message provisoire que pour ce qui manque', () => {
    const { container } = render(<LegalNotice legal={{ ...empty, companyName: 'Acme SAS' }} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Acme SAS');
    expect(text).toContain('Informations en cours de publication');
  });

  it('échappe le contenu (pas de HTML injecté)', () => {
    const { container } = render(<LegalNotice legal={{ ...empty, companyName: '<img src=x onerror=alert(1)>' }} />);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('Politique de confidentialité', () => {
  it('affiche le contact données personnelles quand il est configuré', () => {
    const { getByRole, container } = render(<PrivacyNotice legal={full} />);
    expect(getByRole('link', { name: 'dpo@acme.example' }).getAttribute('href')).toBe('mailto:dpo@acme.example');
    expect(container.textContent).not.toMatch(OPERATOR_HINTS);
  });
  it('sans DPO : repli sur le contact général, sinon message provisoire, sans consigne', () => {
    const a = render(<PrivacyNotice legal={{ ...empty, contactEmail: 'contact@acme.example' }} />);
    expect(a.getByRole('link', { name: 'contact@acme.example' })).toBeTruthy();
    a.unmount();
    const b = render(<PrivacyNotice legal={empty} />);
    expect(b.container.textContent).toContain('Informations en cours de publication');
    expect(b.container.textContent).not.toMatch(OPERATOR_HINTS);
  });
});
