import type { Metadata } from 'next';
import { TEMPLATE_VARIABLES } from '@recoverkit/core';
import { getTemplates, previewTemplate } from '@recoverkit/services';
import { loadAppContext } from '@/server/context';
import { AppShell } from '@/ui/AppShell';
import { Banners } from '@/ui/Banners';
import { Chip } from '@/ui/Chip';
import { Flash } from '@/ui/Flash';
import { resetTemplateAction, saveTemplateAction, sendTestEmailAction } from '../actions';

export const metadata: Metadata = { title: 'Emails' };
export const dynamic = 'force-dynamic';

export default async function EmailsPage({ searchParams }: { searchParams: Promise<{ locale?: string; notice?: string; error?: string; step?: string }> }) {
  const sp = await searchParams;
  const ctx = await loadAppContext();
  const locale = sp.locale === 'en' ? 'en' : 'fr';
  const templates = await getTemplates(ctx.deps, ctx.tenant.id, locale);
  const open = Number(sp.step ?? 0);

  return (
    <AppShell tenantName={ctx.tenant.name} active="emails" activeCases={ctx.activeCases} stripe={ctx.stripe} userEmail={ctx.session.email}>
      <div className="row wrap" style={{ justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="page-title">Emails</h1>
          <p className="page-sub" style={{ maxWidth: '46em' }}>Personnalisez le texte de chaque relance. Vos clients reçoivent la langue de leur profil Stripe, sinon celle de votre compte.</p>
        </div>
        <nav aria-label="Langue des modèles" className="row" style={{ gap: 8 }}>
          <a className="btn btn-s" href="/app/emails?locale=fr" aria-current={locale === 'fr' ? 'page' : undefined} style={locale === 'fr' ? { borderColor: 'var(--blue)', color: 'var(--blue-hover)' } : undefined}>Français</a>
          <a className="btn btn-s" href="/app/emails?locale=en" aria-current={locale === 'en' ? 'page' : undefined} style={locale === 'en' ? { borderColor: 'var(--blue)', color: 'var(--blue-hover)' } : undefined}>English</a>
        </nav>
      </div>
      <Banners alerts={ctx.alerts} />
      <Flash notice={sp.notice} error={sp.error} />
      <p className="muted" style={{ fontSize: 14 }}>Variables disponibles : {TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(', ')}. Le lien {'{{update_link}}'} est obligatoire.</p>

      <div className="stack" style={{ gap: 16 }}>
        {templates.map((t) => {
          const preview = previewTemplate({ subject: t.subject, body: t.body }, locale, ctx.tenant.name);
          return (
            <details key={t.stepIndex} className="panel" open={t.stepIndex === open} style={{ padding: 0 }}>
              <summary className="row" style={{ gap: 16, padding: '18px 20px', cursor: 'pointer', listStyle: 'none' }}>
                <span className="av" style={{ background: 'var(--blue-tint)', color: 'var(--blue-hover)' }} aria-hidden="true">{t.stepIndex + 1}</span>
                <span style={{ flex: 1, minWidth: 0 }}><b style={{ fontWeight: 600, display: 'block' }}>Email {t.stepIndex + 1}</b><span className="muted" style={{ fontSize: 14 }}>{preview.subject}</span></span>
                {t.isCustom ? <Chip tone="info">Personnalisé</Chip> : <Chip tone="neutral">Par défaut</Chip>}
              </summary>
              <div className="cols" style={{ padding: 20, borderTop: '1px solid var(--line)', alignItems: 'flex-start' }}>
                <form action={saveTemplateAction} className="col-main stack" style={{ gap: 16 }}>
                  <input type="hidden" name="stepIndex" value={t.stepIndex} />
                  <input type="hidden" name="locale" value={locale} />
                  <div><label className="label" htmlFor={`subject-${t.stepIndex}`}>Objet</label><input id={`subject-${t.stepIndex}`} name="subject" className="field" defaultValue={t.subject} required /></div>
                  <div><label className="label" htmlFor={`body-${t.stepIndex}`}>Message</label><textarea id={`body-${t.stepIndex}`} name="body" className="field" rows={10} defaultValue={t.body} required /></div>
                  <div className="row wrap" style={{ gap: 12 }}>
                    <button type="submit" className="btn btn-p">Enregistrer</button>
                  </div>
                </form>
                <div className="col-side stack" style={{ gap: 12 }}>
                  <div style={{ background: 'var(--bg)', borderRadius: 16, padding: 16 }}>
                    <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Aperçu avec des données d’exemple</p>
                    <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 16, padding: 20, whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6 }}>
                      <b>{preview.subject}</b>{'\n\n'}{preview.text.split('\n--\n')[0]}
                    </div>
                  </div>
                  <div className="row wrap" style={{ gap: 8 }}>
                    <form action={sendTestEmailAction}><input type="hidden" name="stepIndex" value={t.stepIndex} /><input type="hidden" name="locale" value={locale} /><button type="submit" className="btn btn-s btn-sm">M’envoyer un test</button></form>
                    {t.isCustom ? <form action={resetTemplateAction}><input type="hidden" name="stepIndex" value={t.stepIndex} /><input type="hidden" name="locale" value={locale} /><button type="submit" className="btn btn-s btn-sm">Restaurer le modèle par défaut</button></form> : null}
                  </div>
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </AppShell>
  );
}
