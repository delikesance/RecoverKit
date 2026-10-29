import type { Metadata } from 'next';
import { getDeps } from '@/server/runtime';
import { LegalNotice } from '@/ui/legal/Legal';

export const metadata: Metadata = { title: 'Mentions légales' };
export const dynamic = 'force-dynamic';

export default function Legal() {
  return <LegalNotice legal={getDeps().config.legal} />;
}
