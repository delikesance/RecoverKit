'use server';

import { cookies } from 'next/headers';
import { FLASH_COOKIE } from '@/lib/flash';

/**
 * Efface le flash cookie une fois affiché. Nécessaire quand la page est rendue dans la réponse même de
 * l'action (le proxy n'a alors pas pu l'effacer) : sans cela, le message reviendrait au prochain chargement.
 */
export async function clearFlashAction(): Promise<void> {
  (await cookies()).set(FLASH_COOKIE, '', { path: '/app', maxAge: 0, httpOnly: true, sameSite: 'lax' });
}
