import type { Flash } from './flash';

/** Après une erreur d'enregistrement, le texte saisi pour l'étape concernée (flash cookie) est réaffiché plutôt que le modèle enregistré. */
export function templateDraft(
  flash: Flash | null,
  t: { stepIndex: number; subject: string; body: string },
): { subject: string; body: string } {
  if (flash?.draft && flash.draft.step === t.stepIndex) return { subject: flash.draft.subject, body: flash.draft.body };
  return { subject: t.subject, body: t.body };
}
