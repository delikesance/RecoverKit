import { describe, expect, it } from 'vitest';
import { validateTemplate } from '@recoverkit/core';
import { buildEmail, defaultTemplate } from '../src/templates';

const values = {
  customer_name: 'Camille',
  amount: '29,00 €',
  plan: 'Pro',
  update_link: 'https://app.recoverkit.test/pay/abc123',
  tenant_name: 'Nimbus Notes',
};
const footerOpts = { tenantName: 'Nimbus Notes', supportEmail: 'support@nimbusnotes.example', unsubscribeUrl: 'https://app.recoverkit.test/unsubscribe?x=1' };

describe('defaultTemplate', () => {
  it.each([0, 1, 2, 3])("l'étape %s existe en FR et EN, valide et avec le lien de mise à jour", (step) => {
    for (const locale of ['fr', 'en'] as const) {
      const t = defaultTemplate(step, locale);
      expect(validateTemplate(t)).toEqual({ ok: true, errors: [] });
      expect(t.body).toContain('{{update_link}}');
    }
  });

  it('le ton monte d’étape en étape (le dernier avis est explicite)', () => {
    expect(defaultTemplate(3, 'fr').subject.toLowerCase()).toContain('dernier');
    expect(defaultTemplate(3, 'en').subject.toLowerCase()).toContain('final');
    expect(defaultTemplate(0, 'fr').subject).not.toBe(defaultTemplate(3, 'fr').subject);
  });

  it('retombe sur la dernière étape pour un index supérieur', () => {
    expect(defaultTemplate(9, 'fr')).toEqual(defaultTemplate(3, 'fr'));
  });
});

describe('buildEmail', () => {
  it('rend le sujet, le HTML et le texte avec les valeurs', () => {
    const e = buildEmail({ template: defaultTemplate(0, 'fr'), values, locale: 'fr', ...footerOpts });
    expect(e.subject).toContain('29,00 €');
    expect(e.html).toContain('Camille');
    expect(e.text).toContain('Camille');
    expect(e.text).toContain('https://app.recoverkit.test/pay/abc123');
  });

  it('transforme le paragraphe contenant seulement le lien en bouton', () => {
    const e = buildEmail({ template: defaultTemplate(0, 'fr'), values, locale: 'fr', ...footerOpts });
    expect(e.html).toMatch(/<a href="https:\/\/app\.recoverkit\.test\/pay\/abc123"[^>]*>[^<]+<\/a>/);
  });

  it('échappe le HTML des valeurs (nom du client)', () => {
    const e = buildEmail({
      template: defaultTemplate(0, 'fr'),
      values: { ...values, customer_name: '<img src=x onerror=alert(1)>' },
      locale: 'fr',
      ...footerOpts,
    });
    expect(e.html).not.toContain('<img src=x');
    expect(e.html).toContain('&lt;img');
    expect(e.text).toContain('<img src=x onerror=alert(1)>');
  });

  it('ajoute un pied avec le tenant, le contact et le lien de désinscription', () => {
    const fr = buildEmail({ template: defaultTemplate(0, 'fr'), values, locale: 'fr', ...footerOpts });
    expect(fr.html).toContain('Nimbus Notes');
    expect(fr.html).toContain('support@nimbusnotes.example');
    expect(fr.html).toContain('https://app.recoverkit.test/unsubscribe?x=1');
    expect(fr.text).toContain('https://app.recoverkit.test/unsubscribe?x=1');
    expect(fr.text.toLowerCase()).toContain('relances');

    const en = buildEmail({ template: defaultTemplate(0, 'en'), values, locale: 'en', ...footerOpts });
    expect(en.text.toLowerCase()).toContain('unsubscribe');
  });

  it('omet le contact s’il n’est pas renseigné', () => {
    const e = buildEmail({ template: defaultTemplate(0, 'fr'), values, locale: 'fr', ...footerOpts, supportEmail: null });
    expect(e.html).not.toContain('mailto:');
  });

  it("refuse un template invalide (pas de lien)", () => {
    expect(() => buildEmail({ template: { subject: 's', body: 'sans lien' }, values, locale: 'fr', ...footerOpts })).toThrow(/update_link/);
  });

  it('conserve les sauts de ligne simples dans un paragraphe', () => {
    const e = buildEmail({ template: { subject: 's', body: 'Ligne 1\nLigne 2\n\n{{update_link}}' }, values, locale: 'fr', ...footerOpts });
    expect(e.html).toContain('Ligne 1<br>Ligne 2');
  });

  it('affiche un bandeau (mode test) en haut du message quand il est fourni, en échappant le texte', () => {
    const e = buildEmail({ template: defaultTemplate(0, 'fr'), values, locale: 'fr', ...footerOpts, banner: 'Mode test <b>' });
    expect(e.html).toContain('Mode test &lt;b&gt;');
    expect(e.html.indexOf('Mode test')).toBeLessThan(e.html.indexOf('Camille'));
    expect(e.text.startsWith('[Mode test <b>]')).toBe(true);
    const none = buildEmail({ template: defaultTemplate(0, 'fr'), values, locale: 'fr', ...footerOpts });
    expect(none.html).not.toContain('Mode test');
  });
});
