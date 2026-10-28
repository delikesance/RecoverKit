import { partsInZone, zonedToUtc } from './timezone';

export interface SequenceStep {
  index: number;
  delayMinutes: number;
  active: boolean;
}

export interface SendWindow {
  startHour: number;
  endHour: number;
  timeZone: string;
}

export const DEFAULT_WINDOW: Omit<SendWindow, 'timeZone'> = { startHour: 9, endHour: 19 };

export const DEFAULT_SEQUENCE: readonly SequenceStep[] = [
  { index: 0, delayMinutes: 60, active: true },
  { index: 1, delayMinutes: 3 * 1440, active: true },
  { index: 2, delayMinutes: 7 * 1440, active: true },
  { index: 3, delayMinutes: 12 * 1440, active: true },
];

/** Écart minimal entre deux emails d'un même dossier (jamais de rafale). */
export const MIN_GAP_MS = 12 * 60 * 60 * 1000;

/** Premier instant ≥ `date` situé dans la fenêtre d'envoi [startHour, endHour) du fuseau. */
export function nextWindowInstant(date: Date, window: SendWindow): Date {
  const p = partsInZone(date, window.timeZone);
  if (p.h >= window.startHour && p.h < window.endHour) return new Date(date.getTime());
  if (p.h < window.startHour) {
    return zonedToUtc(p.y, p.m, p.d, window.startHour, 0, window.timeZone);
  }
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return zonedToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    window.startHour,
    0,
    window.timeZone,
  );
}

export interface ScheduledStepPlan {
  stepIndex: number;
  dueAt: Date;
}

export function scheduleSteps(input: {
  failedAt: Date;
  now: Date;
  steps: readonly SequenceStep[];
  window: SendWindow;
}): ScheduledStepPlan[] {
  const active = input.steps
    .filter((s) => s.active)
    .sort((a, b) => a.delayMinutes - b.delayMinutes || a.index - b.index);

  const plans: ScheduledStepPlan[] = [];
  let previous: number | null = null;
  for (const step of active) {
    const raw = input.failedAt.getTime() + step.delayMinutes * 60_000;
    let candidate = Math.max(raw, input.now.getTime());
    if (previous !== null) candidate = Math.max(candidate, previous + MIN_GAP_MS);
    const dueAt = nextWindowInstant(new Date(candidate), input.window);
    plans.push({ stepIndex: step.index, dueAt });
    previous = dueAt.getTime();
  }
  return plans;
}
