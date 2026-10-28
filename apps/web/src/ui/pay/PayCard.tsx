import type { ReactNode } from 'react';
import { LogoMark } from '@/ui/icons';

/** Cadre commun des pages client : mobile d'abord, aucune navigation vers l'espace fondateur. */
export function PayCard({ tenantName, children }: { tenantName?: string; children: ReactNode }) {
  return (
    <main className="auth-wrap">
      <div className="panel auth-card">
        <div className="brand" style={{ padding: 0, marginBottom: 24 }}>
          <span className="brand-mark"><LogoMark /></span> {tenantName ?? 'RecoverKit'}
        </div>
        {children}
      </div>
    </main>
  );
}
