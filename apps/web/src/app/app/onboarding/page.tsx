import type { Metadata } from 'next';
import { DEFAULT_TENANT_NAME, getOnboardingStatus } from '@recoverkit/services';
import { loadAppContext } from '@/server/context';
import { readFlash } from '@/server/flash';
import { AppShell } from '@/ui/AppShell';
import { Flash } from '@/ui/Flash';
import { FlashClear } from '@/ui/FlashClear';
import { acknowledgeNativeEmailsAction, confirmSenderAction, saveCompanyNameAction, sendTestEmailAction, setDryRunAction } from '../actions';

export const metadata: Metadata = { title: 'Mise en route' };
export const dynamic = 'force-dynamic';

const STRIPE_MESSAGES: Record<string, { tone: 'info' | 'critical'; text: string }> = {
  connected: { tone: 'info', text: 'Stripe est connecté. Passez à l’étape suivante.' },
  denied: { tone: 'critical', text: 'Vous avez refusé l’autorisation sur Stripe. Rien n’a été connecté.' },
  invalid: { tone: 'critical', text: 'La demande de connexion a expiré. Recommencez.' },
  error: { tone: 'critical', text: 'Stripe n’a pas confirmé la connexion. Recommencez dans un instant.' },
  taken: { tone: 'critical', text: 'Ce compte Stripe est déjà relié à un autre compte RecoverKit.' },
};

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ stripe?: string; notice?: string }> }) {
  const sp = await searchParams;
  const flash = await readFlash('/app/onboarding');
  const ctx = await loadAppContext();
  const status = await getOnboardingStatus(ctx.deps, ctx.tenant.id);
  const done = Object.fromEntries(status.steps.map((s) => [s.key, s.done])) as Record<string, boolean>;
  const stripeMsg = sp.stripe ? STRIPE_MESSAGES[sp.stripe] : undefined;
  const current = status.current;
  const num = (n: number, key: string) => (
    <span className="av" style={done[key] ? { background: 'var(--green)', color: '#fff' } : current === key ? { background: 'var(--blue)', color: '#fff' } : undefined} aria-hidden="true">{done[key] ? '✓' : n}</span>
  );
  const nameSet = ctx.tenant.name.trim().toLowerCase() !== DEFAULT_TENANT_NAME.toLowerCase();
  const hasTest = !!(await ctx.deps.pool.query(`select onboarding->>'testEmailSentAt' as t from tenants where id = $1`, [ctx.tenant.id])).rows[0]?.t;

  return (
    <AppShell tenantName={ctx.tenant.name} active="settings" activeCases={ctx.activeCases} stripe={ctx.stripe} userEmail={ctx.session.email}>
      <div>
        <h1 className="page-title">Mise en route</h1>
        <p className="page-sub">Quatre étapes pour que vos paiements échoués soient relancés automatiquement.</p>
      </div>
      <Flash notice={sp.notice} error={flash?.error} />
      {flash ? <FlashClear /> : null}
      {stripeMsg ? <div className={`banner banner-${stripeMsg.tone}`} role={stripeMsg.tone === 'critical' ? 'alert' : 'status'}><span className="grow">{stripeMsg.text}</span></div> : null}

      <ol className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 16, maxWidth: 760 }}>
        <li className="panel" style={{ padding: 24 }} aria-current={current === 'stripe' ? 'step' : undefined}>
          <div className="row" style={{ gap: 16 }}>{num(1, 'stripe')}<h2 className="section-title">Connecter Stripe</h2></div>
          <p className="muted" style={{ margin: '12px 0 16px 52px' }}>Vous serez redirigé vers Stripe pour autoriser RecoverKit à lire vos factures et à relancer les paiements. Aucune donnée de carte n’est stockée chez nous.</p>
          <div style={{ marginLeft: 52 }}>{done.stripe ? <span className="chip chip-success">Stripe connecté</span> : <a href="/api/stripe/oauth/start" className="btn btn-p">Se connecter avec Stripe</a>}</div>
        </li>
        <li className="panel" style={{ padding: 24 }} aria-current={current === 'sender' ? 'step' : undefined}>
          <div className="row" style={{ gap: 16 }}>{num(2, 'sender')}<h2 className="section-title">Choisir l’expéditeur des emails</h2></div>
          <p className="muted" style={{ margin: '12px 0 16px 52px' }}>Par défaut, les emails partent d’une adresse RecoverKit avec le nom de votre entreprise et votre adresse en réponse. Vous pourrez utiliser votre propre domaine dans les réglages.</p>
          <div className="row wrap" style={{ marginLeft: 52, gap: 12 }}>
            {done.sender ? <span className="chip chip-success">Expéditeur choisi</span> : (
              <>
                <form action={confirmSenderAction}><button type="submit" className="btn btn-p" disabled={!done.stripe}>Garder l’expéditeur par défaut</button></form>
                <a href="/app/settings" className="btn btn-s">Utiliser mon domaine</a>
              </>
            )}
          </div>
        </li>
        <li className="panel" style={{ padding: 24 }} aria-current={current === 'native_emails' ? 'step' : undefined}>
          <div className="row" style={{ gap: 16 }}>{num(3, 'native_emails')}<h2 className="section-title">Désactiver les relances natives de Stripe</h2></div>
          <p className="muted" style={{ margin: '12px 0 16px 52px' }}>Dans Stripe, ouvrez Paramètres, Facturation, Abonnements et emails, et désactivez les emails de relance pour paiements échoués. Sinon vos clients recevraient deux messages.</p>
          <div style={{ marginLeft: 52 }}>
            {done.native_emails ? <span className="chip chip-success">Confirmé</span> : (
              <form action={acknowledgeNativeEmailsAction}><button type="submit" className="btn btn-p" disabled={!done.sender}>C’est fait dans Stripe</button></form>
            )}
          </div>
        </li>
        <li className="panel" style={{ padding: 24 }} aria-current={current === 'activate' ? 'step' : undefined}>
          <div className="row" style={{ gap: 16 }}>{num(4, 'activate')}<h2 className="section-title">Tester, puis activer</h2></div>
          <p className="muted" style={{ margin: '12px 0 16px 52px' }}>En mode test, RecoverKit enregistre ce qui serait envoyé sans écrire à vos clients. Envoyez-vous d’abord un email de test, puis activez les vrais envois.</p>
          <form action={saveCompanyNameAction} className="row wrap" style={{ margin: '0 0 16px 52px', gap: 12, alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 260px', maxWidth: 380 }}>
              <label htmlFor="company-name" className="label">Nom affiché à vos clients</label>
              <input id="company-name" name="name" className="field" required maxLength={80} defaultValue={nameSet ? ctx.tenant.name : ''} placeholder="Nimbus Notes" autoComplete="organization" aria-describedby="company-name-hint" />
            </div>
            <button type="submit" className="btn btn-s">Enregistrer le nom</button>
            <p id="company-name-hint" className="hint" style={{ flexBasis: '100%', margin: 0 }}>Il apparaît dans l’objet et la signature des emails, et sur la page de paiement. {nameSet ? '' : 'Il est requis pour activer les relances.'}</p>
          </form>
          <div className="row wrap" style={{ marginLeft: 52, gap: 12 }}>
            <form action={sendTestEmailAction}><input type="hidden" name="stepIndex" value="0" /><input type="hidden" name="locale" value="fr" /><input type="hidden" name="from" value="onboarding" /><button type="submit" className="btn btn-s" disabled={!done.native_emails}>M’envoyer un email de test</button></form>
            {done.activate ? <span className="chip chip-success">Relances actives</span> : (
              <form action={setDryRunAction}><input type="hidden" name="mode" value="live" /><input type="hidden" name="from" value="onboarding" /><button type="submit" className="btn btn-p" disabled={!done.native_emails || !hasTest || !nameSet}>Activer les relances</button></form>
            )}
          </div>
          {done.native_emails && !hasTest && !done.activate ? <p className="hint" style={{ marginLeft: 52 }}>Envoyez-vous l’email de test pour débloquer l’activation.</p> : null}
        </li>
      </ol>
      {status.complete ? <a href="/app" className="btn btn-p btn-lg" style={{ alignSelf: 'flex-start' }}>Aller au tableau de bord</a> : null}
    </AppShell>
  );
}
