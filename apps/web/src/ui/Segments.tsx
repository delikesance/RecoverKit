import { stepsLabel } from '@/lib/format';

/** Progression de la séquence : un segment par email, plein quand il est parti. */
export function Segments({ sent, total }: { sent: number; total: number }) {
  const label = sent === 0 || total === 0 ? stepsLabel(sent, total) : `Email ${sent} sur ${total} envoyé`;
  return (
    <div className="seg" role="img" aria-label={label}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < sent ? 'f' : undefined} />
      ))}
    </div>
  );
}
