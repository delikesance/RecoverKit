import type { Metadata } from 'next';
import { MIN_GAP_MS } from '@recoverkit/core';
import { getSequence, getTemplates } from '@recoverkit/services';
import { loadAppContext } from '@/server/context';
import { readFlash } from '@/server/flash';
import { AppShell } from '@/ui/AppShell';
import { Banners } from '@/ui/Banners';
import { Chip } from '@/ui/Chip';
import { Flash } from '@/ui/Flash';
import { FlashClear } from '@/ui/FlashClear';
import { sendMode } from '@/lib/format';
import { saveSequenceAction } from '../actions';

export const metadata: Metadata = { title: 'Séquence de relance' };
export const dynamic = 'force-dynamic';

const MIN_GAP_HOURS = MIN_GAP_MS / 3600_000;

function splitDelay(minutes: number): { value: string; unit: 'hours' | 'days' } {
  if (minutes % 1440 === 0) return { value: String(minutes / 1440), unit: 'days' };
  return { value: String(+(minutes / 60).toFixed(2)), unit: 'hours' };
}

export default async function SequencePage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const sp = await searchParams;
  const flash = await readFlash('/app/sequence');
  const ctx = await loadAppContext();
  const seq = await getSequence(ctx.deps, ctx.tenant.id);
  const templates = await getTemplates(ctx.deps, ctx.tenant.id, ctx.tenant.locale);
  const mode = sendMode(ctx.tenant);
  const slots = Array.from({ length: 6 }, (_, i) => seq?.steps[i] ?? null);

  return (
    <AppShell tenantName={ctx.tenant.name} active="sequence" activeCases={ctx.activeCases} stripe={ctx.stripe} userEmail={ctx.session.email}>
      <div className="row wrap" style={{ justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="page-title">Séquence de relance</h1>
          <p className="page-sub" style={{ maxWidth: '46em' }}>Les emails partent dans cet ordre après un paiement refusé. La séquence s’arrête dès que la facture est payée.</p>
        </div>
        <Chip tone={mode.tone}>{mode.label}</Chip>
      </div>
      <Banners alerts={ctx.alerts} />
      <Flash notice={sp.notice} error={flash?.error} />
      {flash ? <FlashClear /> : null}

      <form action={saveSequenceAction} className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {slots.map((s, i) => {
            const d = s ? splitDelay(s.delayMinutes) : { value: '', unit: 'days' as const };
            const t = templates[i];
            return (
              <li key={i} className="row wrap" style={{ gap: 16, padding: '18px 20px', borderTop: i === 0 ? 0 : '1px solid var(--line)', background: s ? undefined : '#fafbfc' }}>
                <span className="av" style={{ background: s ? 'var(--blue-tint)' : '#eef1f5', color: s ? 'var(--blue-hover)' : 'var(--ink3)' }} aria-hidden="true">{i + 1}</span>
                <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                  <b style={{ fontWeight: 600, display: 'block' }}>{s ? (t?.subject ?? `Email ${i + 1}`) : `Étape ${i + 1} (libre)`}</b>
                  <span className="muted" style={{ fontSize: 14 }}>{s ? (i === 0 ? 'Délai après l’échec de paiement' : `Délai après l’échec de paiement, ${MIN_GAP_HOURS} h minimum après l’email précédent`) : 'Laissez vide pour ne pas utiliser cette étape'}</span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <label htmlFor={`delay_${i}`} className="sr-only">Délai de l’étape {i + 1}</label>
                  <input id={`delay_${i}`} name={`delay_${i}`} inputMode="decimal" defaultValue={d.value} className="field" style={{ width: 96 }} />
                  <label htmlFor={`unit_${i}`} className="sr-only">Unité de l’étape {i + 1}</label>
                  <select id={`unit_${i}`} name={`unit_${i}`} defaultValue={d.unit} className="field" style={{ width: 110 }}>
                    <option value="hours">heures</option><option value="days">jours</option>
                  </select>
                </div>
                <label className="row" style={{ gap: 8, fontWeight: 500, minHeight: 44 }}>
                  <input type="checkbox" name={`active_${i}`} defaultChecked={s ? s.active : true} style={{ width: 20, height: 20 }} /> Activée
                </label>
              </li>
            );
          })}
        </ol>
        <div className="row wrap" style={{ gap: 16, padding: 20, borderTop: '1px solid var(--line)', background: '#fafbfc', justifyContent: 'space-between' }}>
          <p className="muted" style={{ fontSize: 14, maxWidth: '44em' }}>Entre 1 et 6 étapes, au moins 1 heure après l’échec, dans l’ordre croissant. Quel que soit le délai choisi, {MIN_GAP_HOURS} heures minimum séparent deux emails, et les envois sont décalés dans la fenêtre d’envoi : des délais rapprochés ne produisent donc pas une rafale d’emails. Les changements ne concernent que les <b>nouveaux</b> paiements échoués : les relances déjà planifiées ne bougent pas.</p>
          <button className="btn btn-p" type="submit">Enregistrer la séquence</button>
        </div>
      </form>

      <section className="panel" style={{ padding: 24 }}>
        <h2 className="section-title">Règles d’envoi</h2>
        <div style={{ marginTop: 8 }}>
          <div className="kv"><span>Fenêtre d’envoi</span><b style={{ fontWeight: 600 }}>{ctx.tenant.sendStartHour} h à {ctx.tenant.sendEndHour} h, {ctx.tenant.timeZone}</b></div>
          <div className="kv"><span>Écart minimal entre deux emails</span><b style={{ fontWeight: 600 }}>{MIN_GAP_HOURS} h</b></div>
          <div className="kv"><span>Nouvelle tentative de paiement</span><b style={{ fontWeight: 600 }}>Dès la mise à jour de la carte, et une fois avant le dernier avis</b></div>
          <div className="kv"><span>Expéditeur</span><b style={{ fontWeight: 600 }}>{ctx.tenant.senderVerified && ctx.tenant.senderEmail ? ctx.tenant.senderEmail : 'Adresse par défaut de RecoverKit'}</b></div>
        </div>
        <a href="/app/settings" className="btn btn-s" style={{ marginTop: 16 }}>Modifier les règles d’envoi</a>
      </section>
    </AppShell>
  );
}
