import type { Clock } from '@recoverkit/core';

export interface Task {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

interface LoggerLike {
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
}

interface State {
  task: Task;
  nextAt: number;
  running: Promise<void> | null;
  runs: number;
  failures: number;
}

/** Planificateur minimal : chaque tâche à son rythme, sans chevauchement, une erreur n'arrête rien. */
export class Scheduler {
  private readonly states = new Map<string, State>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly clock: Clock,
    private readonly log: LoggerLike,
  ) {}

  add(task: Task): void {
    if (this.states.has(task.name)) throw new Error(`La tâche ${task.name} existe déjà`);
    if (!(task.everyMs > 0)) throw new Error(`Intervalle invalide pour ${task.name}`);
    this.states.set(task.name, { task, nextAt: 0, running: null, runs: 0, failures: 0 });
  }

  stats(name: string): { runs: number; failures: number } {
    const s = this.states.get(name);
    if (!s) throw new Error(`Tâche inconnue : ${name}`);
    return { runs: s.runs, failures: s.failures };
  }

  /** Lance les tâches échues et attend la fin de celles qu'elle vient de démarrer. */
  async tick(): Promise<void> {
    const now = this.clock.now().getTime();
    const started: Promise<void>[] = [];
    for (const s of this.states.values()) {
      if (s.running || now < s.nextAt || this.stopped) continue;
      s.nextAt = now + s.task.everyMs;
      s.running = (async () => {
        try {
          await s.task.run();
        } catch (e) {
          s.failures++;
          this.log.error({ task: s.task.name, err: (e as Error).message }, 'tâche en erreur');
        } finally {
          s.runs++;
          s.running = null;
        }
      })();
      started.push(s.running);
    }
    await Promise.all(started);
  }

  start(pollMs = 1000): void {
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      void this.tick().finally(() => {
        if (!this.stopped) this.timer = setTimeout(loop, pollMs);
      });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.all([...this.states.values()].map((s) => s.running));
  }
}
