import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession, type SessionIdentity } from '@recoverkit/services';
import { getDeps } from './runtime';

export async function getSessionOrNull(): Promise<SessionIdentity | null> {
  const token = (await cookies()).get('rk_session')?.value;
  if (!token) return null;
  return getSession(getDeps(), token);
}

/** Toute page et toute action de l'espace fondateur passent par ici : session valide ou redirection. */
export async function requireSession(): Promise<SessionIdentity> {
  const session = await getSessionOrNull();
  if (!session) redirect('/login');
  return session;
}
