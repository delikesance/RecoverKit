export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export interface Duration {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

export function durationToMs(d: Duration): number {
  return (
    ((d.days ?? 0) * 24 * 60 * 60 + (d.hours ?? 0) * 60 * 60 + (d.minutes ?? 0) * 60 + (d.seconds ?? 0)) * 1000
  );
}

export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(date: Date): void {
    this.current = new Date(date.getTime());
  }

  advance(d: Duration): void {
    this.current = new Date(this.current.getTime() + durationToMs(d));
  }
}
