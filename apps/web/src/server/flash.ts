import { cookies, headers } from 'next/headers';
import { FLASH_COOKIE, FLASH_HEADER, FLASH_TTL_SECONDS, decodeFlash, encodeFlash, type Flash } from '@/lib/flash';

/** Pose le flash cookie (action serveur uniquement) : httpOnly, SameSite=Lax, ~60 s, limité à /app. */
export async function setFlash(flash: Flash): Promise<void> {
  (await cookies()).set(FLASH_COOKIE, encodeFlash(flash), {
    path: '/app',
    maxAge: FLASH_TTL_SECONDS,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
}

/**
 * Lit le flash destiné à `path`. Le proxy a copié le cookie dans un en-tête interne et l'a effacé
 * (lecture unique) ; à défaut (rendu dans la réponse même de l'action) on lit le cookie.
 */
export async function readFlash(path: string): Promise<Flash | null> {
  const fromProxy = (await headers()).get(FLASH_HEADER);
  let raw: string | undefined;
  try {
    raw = fromProxy !== null ? decodeURIComponent(fromProxy) : (await cookies()).get(FLASH_COOKIE)?.value;
  } catch {
    return null;
  }
  return decodeFlash(raw, path);
}
