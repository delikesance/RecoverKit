import type { Metadata } from 'next';
import { getDeps } from '@/server/runtime';
import { PrivacyNotice } from '@/ui/legal/Legal';

export const metadata: Metadata = { title: 'Politique de confidentialité' };
export const dynamic = 'force-dynamic';

export default function Privacy() {
  return <PrivacyNotice legal={getDeps().config.legal} />;
}
