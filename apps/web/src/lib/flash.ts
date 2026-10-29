/**
 * Flash cookie : message d'erreur et brouillon de modèle transportés hors de l'URL
 * (limites de taille de l'en-tête Location, texte forgeable via un lien). Posé par l'action
 * serveur, lu puis effacé côté serveur (proxy.ts), valable quelques secondes.
 */
export const FLASH_COOKIE = 'rk_flash';
export const FLASH_HEADER = 'x-rk-flash';
export const FLASH_TTL_SECONDS = 60;
const MAX_ENCODED = 3500; // marge sous la limite de 4096 octets d'un cookie
const MAX_ERROR = 300;

export interface Flash {
  /** Page à laquelle le message est destiné (pas d'affichage ailleurs). */
  path: string;
  error?: string;
  draft?: { step: number; locale: 'fr' | 'en'; subject: string; body: string };
}

/** Valeur JSON du cookie (l'API cookies l'encode en pourcentage à l'écriture et la décode à la lecture). */
export function encodeFlash(flash: Flash): string {
  const f: Flash = { ...flash, ...(flash.error !== undefined ? { error: flash.error.slice(0, MAX_ERROR) } : {}) };
  if (f.draft) f.draft = { ...f.draft, subject: f.draft.subject.slice(0, 500), body: f.draft.body.slice(0, 2500) };
  let out = JSON.stringify(f);
  // La valeur de cookie est encodée en pourcentage (le texte accentué grossit) : on réduit le corps jusqu'à tenir dans un cookie.
  while (encodeURIComponent(out).length > MAX_ENCODED && f.draft && (f.draft.body.length > 0 || f.draft.subject.length > 0)) {
    f.draft = f.draft.body.length > 0
      ? { ...f.draft, body: f.draft.body.slice(0, Math.floor(f.draft.body.length * 0.8)) }
      : { ...f.draft, subject: f.draft.subject.slice(0, Math.floor(f.draft.subject.length * 0.8)) };
    out = JSON.stringify(f);
  }
  return out;
}

/** Décode et valide un flash ; null s'il est absent, malformé ou destiné à une autre page. */
export function decodeFlash(raw: string | null | undefined, path: string): Flash | null {
  if (!raw || raw.length > 4000) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (o.path !== path) return null;
    const out: Flash = { path };
    if (typeof o.error === 'string') out.error = o.error.slice(0, MAX_ERROR);
    const d = o.draft as Record<string, unknown> | undefined;
    if (d && typeof d === 'object' && typeof d.subject === 'string' && typeof d.body === 'string' && Number.isInteger(d.step)) {
      out.draft = { step: d.step as number, locale: d.locale === 'en' ? 'en' : 'fr', subject: d.subject.slice(0, 500), body: d.body.slice(0, 2500) };
    }
    return out;
  } catch {
    return null;
  }
}
