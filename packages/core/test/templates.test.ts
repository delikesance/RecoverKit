import { describe, expect, it } from 'vitest';
import { TEMPLATE_VARIABLES, renderTemplate, validateTemplate } from '../src/templates';

const vars = {
  customer_name: 'Camille',
  amount: '29,00 €',
  plan: 'Pro',
  update_link: 'https://app.example/pay/abc',
  tenant_name: 'Nimbus Notes',
};

describe('validateTemplate', () => {
  it('accepte un template valide', () => {
    const r = validateTemplate({
      subject: 'Votre paiement de {{amount}} a échoué',
      body: 'Bonjour {{customer_name}}, mettez à jour : {{ update_link }}',
    });
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it('refuse une variable inconnue et la nomme', () => {
    const r = validateTemplate({ subject: 'Salut', body: '{{update_link}} {{inconnue}}' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('inconnue');
  });

  it('exige update_link dans le corps', () => {
    const r = validateTemplate({ subject: 'Salut', body: 'Bonjour {{customer_name}}' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('update_link');
  });

  it('refuse un sujet ou un corps vide', () => {
    expect(validateTemplate({ subject: '  ', body: '{{update_link}}' }).ok).toBe(false);
    expect(validateTemplate({ subject: 'x', body: '   ' }).ok).toBe(false);
  });

  it('refuse des accolades non fermées', () => {
    const r = validateTemplate({ subject: 'x', body: '{{update_link}} {{customer_name' });
    expect(r.ok).toBe(false);
  });

  it('refuse update_link dans le sujet seul (le corps reste obligatoire)', () => {
    expect(validateTemplate({ subject: '{{update_link}}', body: 'sans lien' }).ok).toBe(false);
  });

  it('expose la liste des variables autorisées', () => {
    expect([...TEMPLATE_VARIABLES].sort()).toEqual(
      ['amount', 'customer_name', 'plan', 'tenant_name', 'update_link'].sort(),
    );
  });
});

describe('renderTemplate', () => {
  it('remplace les variables, espaces tolérés', () => {
    const out = renderTemplate(
      { subject: 'Paiement de {{ amount }}', body: 'Bonjour {{customer_name}}, {{update_link}}' },
      vars,
    );
    expect(out.subject).toBe('Paiement de 29,00 €');
    expect(out.body).toBe('Bonjour Camille, https://app.example/pay/abc');
  });

  it('échappe le HTML des valeurs dans le corps', () => {
    const out = renderTemplate(
      { subject: 's', body: '<p>{{customer_name}} {{update_link}}</p>' },
      { ...vars, customer_name: '<script>alert(1)</script> & "x"' },
      { html: true },
    );
    expect(out.body).not.toContain('<script>');
    expect(out.body).toContain('&lt;script&gt;');
    expect(out.body).toContain('&amp;');
    expect(out.body).toContain('&quot;x&quot;');
    expect(out.body.startsWith('<p>')).toBe(true);
  });

  it("n'échappe pas le sujet (texte brut)", () => {
    const out = renderTemplate(
      { subject: '{{customer_name}}', body: '{{update_link}}' },
      { ...vars, customer_name: 'A & B' },
      { html: true },
    );
    expect(out.subject).toBe('A & B');
  });

  it('lève une erreur quand une valeur est manquante', () => {
    const { plan: _omit, ...partial } = vars;
    expect(() =>
      renderTemplate({ subject: '{{plan}}', body: '{{update_link}}' }, partial as typeof vars),
    ).toThrow(/plan/);
  });

  it("refuse de rendre un template invalide", () => {
    expect(() => renderTemplate({ subject: 's', body: 'sans lien' }, vars)).toThrow(/update_link/);
  });
});
