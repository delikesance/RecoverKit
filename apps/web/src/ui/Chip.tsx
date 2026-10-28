import type { ReactNode } from 'react';
import type { Tone } from '@/lib/format';

export function Chip({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}
