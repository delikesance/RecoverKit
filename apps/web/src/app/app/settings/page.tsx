import type { Metadata } from 'next';
import { checkSenderDomain, getOnboardingStatus } from '@recoverkit/services';
import { loadAppContext } from '@/server/context';
import { AppShell } from '@/ui/AppShell';
import { Banners } from '@/ui/Banners';
import { Chip } from '@/ui/Chip';
import { Flash } from '@/ui/Flash';
import {
  checkSenderAction,
  configureSenderAction,
  deleteAccountAction,
  disconnectStripeAction,
  removeSenderAction,
  setDryRunAction,
  updateSettingsAction,
} from '../actions';

export const metadata: Metadata = { title: 'Réglages' };
export const dynamic = 'force-dynamic';

const ZONES = ['Europe/Paris', 'Europe/Brussels', 'Europe/Zurich', 'Europe/London', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Montreal', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const sp = await searchParams;
  const ctx = await loadAppContext();
  const t = ctx.tenant;
  const sender = await checkSenderDomain(ctx.deps, t.id).catch(() => ({ status: 'none' as const }));
  const onboarding = await getOnboardingStatus(ctx.deps, t.id);
  const zones = ZONES.includes(t.timeZone) ? ZONES : [t.timeZone, ...ZONES];

  return (
    <AppShell tenantName={t.name} active="settings" activeCases={ctx.activeCases} stripe={ctx.stripe} userEmail={ctx.session.email}>
      <div><h1 className="page-title">Réglages</h1><p className="page-sub">Votre entreprise, vos envois et vos données.</p></div>
      <Banners alerts={ctx.alerts} />
      <Flash notice={sp.notice} error={sp.error} />

      <section className="panel" style={{ padding: 24 }} aria-labelledby="h-mode">
        <div className="row wrap" style={{ justifyContent: 'space-between', gap: 16 }}>
          <div>
            <h2 id="h-mode" className="section-title">Envois aux clients</h2>
            <p className="muted" style={{ marginTop: 4, maxWidth: '44em' }}>{t.dryRun ? 'Mode test : RecoverKit enregistre ce qui serait envoyé, sans écrire à vos clients ni retenter de paiement.' : 'Relances actives : vos clients reçoivent les emails et les paiements sont retentés.'}</p>
          </div>
          <Chip tone={t.dryRun ? 'warning' : 'success'}>{t.dryRun ? 'Mode test' : 'Relances actives'}</Chip>
        </div>
        <form action={setDryRunAction} className="row wrap" style={{ marginTop: 16, gap: 12 }}>
          <input type="hidden" name="mode" value={t.dryRun ? 'live' : 'test'} />
          <button type="submit" className={t.dryRun ? 'btn btn-p' : 'btn btn-s'}>{t.dryRun ? 'Activer les relances' : 'Repasser en mode test'}</button>
          {t.dryRun && !onboarding.complete ? <a href="/app/onboarding" className="btn btn-s">Terminer la mise en route</a> : null}
        </form>
      </section>

      <form action={updateSettingsAction} className="panel stack" style={{ padding: 24, gap: 16 }}>
        <h2 className="section-title">Entreprise et envois</h2>
        <div className="cols" style={{ gap: 16 }}>
          <div style={{ flex: '1 1 260px' }}><label htmlFor="name" className="label">Nom affiché dans les emails</label><input id="name" name="name" className="field" defaultValue={t.name} required maxLength={80} /></div>
          <div style={{ flex: '1 1 260px' }}><label htmlFor="locale" className="label">Langue par défaut des clients</label>
            <select id="locale" name="locale" className="field" defaultValue={t.locale}><option value="fr">Français</option><option value="en">English</option></select></div>
        </div>
        <div className="cols" style={{ gap: 16 }}>
          <div style={{ flex: '1 1 260px' }}><label htmlFor="supportEmail" className="label">Adresse de contact (pied des emails)</label><input id="supportEmail" name="supportEmail" type="email" className="field" defaultValue={t.supportEmail ?? ''} placeholder="support@votre-entreprise.com" /></div>
          <div style={{ flex: '1 1 260px' }}><label htmlFor="replyTo" className="label">Adresse de réponse</label><input id="replyTo" name="replyTo" type="email" className="field" defaultValue={t.replyTo ?? ''} placeholder="Par défaut : l’adresse de contact" /></div>
        </div>
        <div className="cols" style={{ gap: 16 }}>
          <div style={{ flex: '1 1 260px' }}><label htmlFor="timeZone" className="label">Fuseau horaire</label>
            <select id="timeZone" name="timeZone" className="field" defaultValue={t.timeZone}>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</select></div>
          <div style={{ flex: '1 1 130px' }}><label htmlFor="sendStartHour" className="label">Envoi dès (heure)</label><input id="sendStartHour" name="sendStartHour" type="number" min={0} max={23} className="field" defaultValue={t.sendStartHour} /></div>
          <div style={{ flex: '1 1 130px' }}><label htmlFor="sendEndHour" className="label">Jusqu’à (heure)</label><input id="sendEndHour" name="sendEndHour" type="number" min={1} max={24} className="field" defaultValue={t.sendEndHour} /></div>
        </div>
        <label className="row" style={{ gap: 10, fontWeight: 500, minHeight: 44 }}><input type="checkbox" name="emailsEnabled" defaultChecked={t.emailsEnabled} style={{ width: 20, height: 20 }} /> Envoyer les emails de relance (décochez pour tout suspendre)</label>
        <label className="row" style={{ gap: 10, fontWeight: 500, minHeight: 44 }}><input type="checkbox" name="digestEnabled" defaultChecked={t.digestEnabled} style={{ width: 20, height: 20 }} /> Recevoir le récapitulatif du lundi par email</label>
        <div><button type="submit" className="btn btn-p">Enregistrer</button></div>
      </form>

      <section className="panel stack" style={{ padding: 24, gap: 16 }} aria-labelledby="h-sender">
        <div className="row wrap" style={{ justifyContent: 'space-between', gap: 12 }}>
          <h2 id="h-sender" className="section-title">Expéditeur personnalisé</h2>
          {sender.status === 'verified' ? <Chip tone="success">Domaine vérifié</Chip> : sender.status === 'pending' ? <Chip tone="warning">Vérification en attente</Chip> : sender.status === 'failed' ? <Chip tone="danger">Vérification échouée</Chip> : <Chip tone="neutral">Expéditeur par défaut</Chip>}
        </div>
        <p className="muted" style={{ maxWidth: '46em' }}>Envoyez les relances depuis votre propre adresse pour une meilleure délivrabilité. Tant que le domaine n’est pas vérifié, l’expéditeur par défaut est utilisé.</p>
        <form action={configureSenderAction} className="row wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 220px' }}><label htmlFor="senderName" className="label">Nom d’expéditeur</label><input id="senderName" name="senderName" className="field" defaultValue={t.senderName ?? t.name} /></div>
          <div style={{ flex: '1 1 260px' }}><label htmlFor="senderEmail" className="label">Adresse d’expédition</label><input id="senderEmail" name="senderEmail" type="email" className="field" defaultValue={t.senderEmail ?? ''} placeholder="facturation@votre-domaine.com" required /></div>
          <button type="submit" className="btn btn-s">Enregistrer l’expéditeur</button>
        </form>
        {sender.status === 'pending' || sender.status === 'failed' ? (
          <>
            <div className="table-wrap">
              <table className="data" style={{ minWidth: 560 }}>
                <caption className="sr-only">Enregistrements DNS à ajouter chez votre hébergeur de domaine</caption>
                <thead><tr><th scope="col">Usage</th><th scope="col">Type</th><th scope="col">Nom</th><th scope="col">Valeur</th></tr></thead>
                <tbody>
                  {sender.records.map((r) => (
                    <tr key={`${r.purpose}-${r.type}-${r.name}`}><td>{r.purpose}</td><td>{r.type}</td><td><code>{r.name}</code></td><td style={{ wordBreak: 'break-all' }}><code>{r.value}</code></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <form action={checkSenderAction}><button type="submit" className="btn btn-p">Vérifier maintenant</button></form>
          </>
        ) : null}
        {t.senderEmail ? <form action={removeSenderAction}><button type="submit" className="btn btn-s btn-sm">Supprimer l’expéditeur personnalisé</button></form> : null}
      </section>

      <section className="panel stack" style={{ padding: 24, gap: 12 }} aria-labelledby="h-stripe">
        <h2 id="h-stripe" className="section-title">Connexion Stripe</h2>
        <p className="muted">{ctx.stripe === 'ACTIVE' ? 'Votre compte Stripe est connecté.' : ctx.stripe === 'REVOKED' ? 'La connexion a été révoquée : reconnectez Stripe pour reprendre les relances.' : 'Stripe n’est pas encore connecté.'}</p>
        <div className="row wrap" style={{ gap: 12 }}>
          {ctx.stripe !== 'ACTIVE' ? <a href="/api/stripe/oauth/start" className="btn btn-p">Connecter Stripe</a> : (
            <details className="confirm">
              <summary className="btn btn-danger">Déconnecter Stripe</summary>
              <form action={disconnectStripeAction} className="confirm-box" style={{ maxWidth: 360 }}>
                <p style={{ fontSize: 14, marginBottom: 12 }}>Toutes les relances à venir seront annulées. Vous pourrez reconnecter Stripe à tout moment.</p>
                <button type="submit" className="btn btn-danger btn-sm">Confirmer la déconnexion</button>
              </form>
            </details>
          )}
        </div>
      </section>

      <section className="panel stack" style={{ padding: 24, gap: 12 }} aria-labelledby="h-data">
        <h2 id="h-data" className="section-title">Vos données</h2>
        <p className="muted" style={{ maxWidth: '46em' }}>Exportez tout ce que RecoverKit conserve pour votre compte, ou supprimez définitivement le compte.</p>
        <div><a href="/api/app/export/data" className="btn btn-s">Télécharger mes données (JSON)</a></div>
        <details className="confirm" style={{ marginTop: 8 }}>
          <summary className="btn btn-danger" style={{ display: 'inline-flex' }}>Supprimer mon compte</summary>
          <form action={deleteAccountAction} className="confirm-box" style={{ maxWidth: 440 }}>
            <p style={{ fontSize: 14, marginBottom: 12 }}>Cette action est définitive : relances, dossiers, emails et données de vos clients sont supprimés, et l’accès Stripe est révoqué. Seul le registre comptable des montants récupérés, sans donnée personnelle, est conservé.</p>
            <label htmlFor="confirmName" className="label">Saisissez le nom exact de l’entreprise pour confirmer : <b>{t.name}</b></label>
            <input id="confirmName" name="confirmName" className="field" required autoComplete="off" />
            <button type="submit" className="btn btn-danger btn-sm" style={{ marginTop: 12 }}>Supprimer définitivement</button>
          </form>
        </details>
      </section>
    </AppShell>
  );
}
