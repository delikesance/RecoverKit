export const TEMPLATE_VARIABLES = [
  'customer_name',
  'amount',
  'plan',
  'update_link',
  'tenant_name',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export type TemplateValues = Record<TemplateVariable, string>;

export interface EmailTemplate {
  subject: string;
  body: string;
}

const VARIABLE_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const KNOWN = new Set<string>(TEMPLATE_VARIABLES);

function variablesIn(text: string): string[] {
  return [...text.matchAll(VARIABLE_RE)].map((m) => m[1]!);
}

export function validateTemplate(t: EmailTemplate): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!t.subject.trim()) errors.push('Le sujet est vide.');
  if (!t.body.trim()) errors.push('Le corps est vide.');

  for (const [label, text] of [
    ['sujet', t.subject],
    ['corps', t.body],
  ] as const) {
    const opens = (text.match(/\{\{/g) ?? []).length;
    const closes = (text.match(/\}\}/g) ?? []).length;
    if (opens !== closes) errors.push(`Accolades non fermées dans le ${label}.`);
    for (const name of new Set(variablesIn(text))) {
      if (!KNOWN.has(name)) errors.push(`Variable inconnue dans le ${label} : {{${name}}}.`);
    }
  }

  if (!variablesIn(t.body).includes('update_link')) {
    errors.push('Le corps doit contenir {{update_link}}.');
  }
  return { ok: errors.length === 0, errors };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderTemplate(
  t: EmailTemplate,
  values: TemplateValues,
  opts: { html?: boolean } = {},
): EmailTemplate {
  const check = validateTemplate(t);
  if (!check.ok) throw new Error(check.errors.join(' '));

  const fill = (text: string, escape: boolean) =>
    text.replace(VARIABLE_RE, (_m, name: TemplateVariable) => {
      const value = values[name];
      if (value === undefined) throw new Error(`Valeur manquante pour la variable ${name}`);
      return escape ? escapeHtml(value) : value;
    });

  return { subject: fill(t.subject, false), body: fill(t.body, opts.html === true) };
}
