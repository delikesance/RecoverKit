import type { ReactNode } from 'react';
import { LogoMark } from '../icons';
import { Calculator } from './Calculator';

export interface PlanView {
  key: string;
  name: string;
  priceId: string;
  maxMrr: number | null;
  monthlyPrice: number;
}

const euros = (cents: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);

const FAQ: { q: string; a: string }[] = [
  { q: 'Mes clients reçoivent-ils plusieurs fois le même email ?', a: 'Non. Chaque relance est liée à un seul échec de paiement et n’est jamais envoyée deux fois, même si Stripe renvoie plusieurs fois la même notification.' },
  { q: 'Stockez-vous les cartes de mes clients ?', a: 'Non. La carte est saisie dans un formulaire fourni par Stripe. RecoverKit ne voit jamais le numéro.' },
  { q: 'Puis-je modifier les emails et les délais ?', a: 'Oui. Vous réglez les délais, le texte et l’expéditeur de chaque relance, en français comme en anglais, et vous pouvez tout suspendre à tout moment.' },
  { q: 'Comment le revenu récupéré est-il calculé ?', a: 'Nous comptons uniquement les factures payées après l’envoi d’au moins un de nos emails. Chaque ligne renvoie à la facture Stripe correspondante, et les paiements arrivés avant toute relance sont affichés à part.' },
  { q: 'Et si je veux arrêter ?', a: 'Vous déconnectez Stripe en un clic : les relances s’arrêtent immédiatement. Vous pouvez aussi exporter vos données ou supprimer votre compte.' },
];

function Section({ id, title, children, tint }: { id?: string; title: ReactNode; children: ReactNode; tint?: boolean }) {
  const headingId = `${id ?? 'section'}-titre`;
  return (
    <section id={id} className={`m-sec${tint ? ' m-tint' : ''}`} aria-labelledby={headingId}>
      <div className="m-in">
        <h2 id={headingId} className="m-h2">{title}</h2>
        {children}
      </div>
    </section>
  );
}

export function LandingView({ plans, trialDays }: { plans: PlanView[]; trialDays: number }) {
  return (
    <div className="m">
      <header className="m-header">
        <div className="m-in m-header-in">
          <a href="/" className="brand" style={{ padding: 0 }} aria-label="RecoverKit, accueil"><span className="brand-mark"><LogoMark /></span> RecoverKit</a>
          <nav aria-label="Principal" className="row wrap" style={{ gap: 4 }}>
            <a className="m-link" href="#fonctionnement">Fonctionnement</a>
            <a className="m-link" href="#calculateur">Calculateur</a>
            <a className="m-link" href="#tarifs">Tarifs</a>
            <a className="btn btn-s" href="/login">Se connecter</a>
            <a className="btn btn-p" href="/login">Connecter mon Stripe</a>
          </nav>
        </div>
      </header>

      <main>
        <section className="m-hero" aria-labelledby="titre">
          <div className="m-in">
            <span className="chip chip-info">Pour les SaaS facturés avec Stripe</span>
            <h1 id="titre" className="m-h1">Récupérez les abonnements perdus à cause d’un paiement refusé.</h1>
            <p className="m-lead">RecoverKit prévient vos clients par email, leur fait mettre à jour leur carte en deux clics, puis retente le paiement. Vous suivez chaque euro récupéré.</p>
            <div className="row wrap" style={{ gap: 12 }}>
              <a className="btn btn-p btn-lg" href="/login">Connecter mon Stripe</a>
              <a className="btn btn-s btn-lg" href="#calculateur">Calculer mon gain</a>
            </div>
            <p className="muted" style={{ fontSize: 14, marginTop: 16 }}>Connexion en un clic. Aucune donnée de carte stockée chez nous.</p>

            <figure className="panel m-shot" aria-label="Exemple de tableau de bord">
              <div className="m-shot-bar" aria-hidden="true"><i /><i /><i /></div>
              <div className="m-shot-body">
                <div className="panel" style={{ flex: '1.5 1 420px', padding: 24 }}>
                  <div className="muted" style={{ fontSize: 14, fontWeight: 500 }}>Revenu récupéré en octobre</div>
                  <div className="num m-shot-big">1 284 €</div>
                  <span className="chip chip-success">+18 % par rapport à septembre</span>
                  <svg viewBox="0 0 600 120" preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 120, marginTop: 20 }} role="img" aria-label="Courbe du revenu récupéré, en hausse sur le mois">
                    <path d="M0,108 L50,100 L100,96 L150,82 L200,76 L250,62 L300,56 L350,42 L400,36 L450,26 L500,16 L550,10 L600,4 L600,120 L0,120 Z" fill="#ddf4e9" />
                    <path d="M0,108 L50,100 L100,96 L150,82 L200,76 L250,62 L300,56 L350,42 L400,36 L450,26 L500,16 L550,10 L600,4" fill="none" stroke="#0b7a55" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                  </svg>
                </div>
                <div className="stack" style={{ flex: '1 1 260px', gap: 16 }}>
                  <div className="panel" style={{ padding: '20px 24px' }}><div className="muted" style={{ fontSize: 14 }}>En cours de relance</div><div className="num m-shot-mid">612 €</div><div style={{ fontSize: 14, color: 'var(--ink2)' }}>sur 7 paiements</div></div>
                  <div className="panel" style={{ padding: '20px 24px' }}><div className="muted" style={{ fontSize: 14 }}>Taux de récupération</div><div className="num m-shot-mid">68 %</div><div style={{ fontSize: 14, color: 'var(--ink2)' }}>14 abonnés sauvés</div></div>
                </div>
              </div>
              <figcaption className="muted" style={{ fontSize: 13, padding: '0 20px 16px' }}>Exemple avec des données fictives.</figcaption>
            </figure>
          </div>
        </section>

        <Section id="fonctionnement" title="Trois étapes, ensuite tout tourne seul">
          <p className="m-lead" style={{ marginBottom: 32 }}>Un paiement refusé n’est pas un client qui part : carte expirée, plafond atteint, banque trop prudente. RecoverKit le dit à votre client, au bon moment, puis encaisse.</p>
          <div className="panel m-steps">
            {[
              ['Vous connectez Stripe', 'Une autorisation, sans clé à copier. RecoverKit repère les paiements qui échouent.'],
              ['Vos clients reçoivent un email', 'Un message à votre nom, avec un lien sécurisé. Pas de compte à créer.'],
              ['Le paiement est retenté', 'La carte est à jour, Stripe encaisse, le montant apparaît dans votre tableau de bord.'],
            ].map(([t, d], i) => (
              <div key={t} className="m-step"><span className="chip chip-info">Étape {i + 1}</span><h3 className="m-h3">{t}</h3><p className="muted">{d}</p></div>
            ))}
          </div>
        </Section>

        <section className="m-sec m-tint" aria-label="Ce que vous contrôlez">
          <div className="m-in stack" style={{ gap: 64 }}>
            <div className="m-feature"><div><h2 className="m-h2 m-h2-sm">Des relances que vous contrôlez</h2><p className="m-lead">Choisissez le délai de chaque email, modifiez le texte et l’expéditeur, mettez en pause un dossier quand un client vous écrit.</p></div>
              <div className="panel" style={{ padding: 28 }}><div className="muted" style={{ fontSize: 13 }}>Objet : Votre paiement n’a pas abouti</div><div className="m-mail-title">Bonjour Camille, votre carte a été refusée.</div><p className="muted" style={{ marginBottom: 20 }}>Mettez-la à jour en une minute pour garder l’accès à vos notes.</p><span className="btn btn-p" style={{ width: '100%' }}>Mettre à jour ma carte</span></div></div>
            <div className="m-feature"><div><h2 className="m-h2 m-h2-sm">Une page de paiement sûre, faite pour le téléphone</h2><p className="m-lead">Le client arrive depuis son email et saisit sa carte via Stripe. Son lien est personnel, expire seul et ne donne jamais accès à votre tableau de bord.</p></div>
              <div className="panel" style={{ padding: 28 }}><div style={{ fontWeight: 600, marginBottom: 12 }}>Votre paiement n’a pas abouti.</div><div className="m-fake-field" /><div className="row" style={{ gap: 8, margin: '8px 0 16px' }}><div className="m-fake-field" /><div className="m-fake-field" /></div><span className="btn btn-p" style={{ width: '100%' }}>Mettre à jour la carte</span></div></div>
            <div className="m-feature"><div><h2 className="m-h2 m-h2-sm">Un chiffre que vous pouvez vérifier</h2><p className="m-lead">Chaque euro récupéré correspond à une facture Stripe payée après une de nos relances. Les paiements arrivés avant tout email ne sont pas comptés.</p></div>
              <div className="panel" style={{ padding: '8px 24px' }}>
                {[['Orbit Labs', 'Payé après l’email 1', '+299,00 €'], ['Yanis Berger', 'Payé après l’email 3', '+79,00 €'], ['Fabrik', 'Payé après l’email 1', '+149,00 €']].map(([n, w, a]) => (
                  <div key={n} className="row" style={{ justifyContent: 'space-between', padding: '16px 0', borderBottom: '1px solid var(--line)' }}><span><b style={{ fontWeight: 600 }}>{n}</b><br /><span className="muted" style={{ fontSize: 14 }}>{w}</span></span><b className="num" style={{ color: 'var(--green)' }}>{a}</b></div>
                ))}
              </div></div>
          </div>
        </section>

        <Section id="calculateur" title="Combien pourriez-vous récupérer ?">
          <p className="m-lead" style={{ marginBottom: 32 }}>Ajustez vos chiffres : le résultat s’affiche tout de suite.</p>
          <Calculator />
        </Section>

        <Section id="tarifs" title="Un tarif fixe, sans commission sur le récupéré" tint>
          <p className="m-lead" style={{ marginBottom: 32 }}>Essayez RecoverKit gratuitement pendant {trialDays} jours, sans engagement.</p>
          {plans.length > 0 ? (
            <div className="kpis">
              {plans.map((p) => (
                <div key={p.key} className="panel stack" style={{ flex: '1 1 280px', padding: 32, gap: 12 }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}><b>{p.name}</b></div>
                  <div className="num m-price">{euros(p.monthlyPrice)}<span className="muted" style={{ fontSize: 16, fontWeight: 500, letterSpacing: 0 }}> par mois</span></div>
                  <p className="muted" style={{ flex: 1 }}>{p.maxMrr === null ? 'Sans limite de revenu mensuel récurrent' : `Jusqu’à ${euros(p.maxMrr)} de revenu mensuel récurrent`}</p>
                  <a href="/login" className="btn btn-p">Commencer</a>
                </div>
              ))}
            </div>
          ) : (
            <div className="panel stack" style={{ padding: 32, gap: 12, maxWidth: 520 }}>
              <b>Essai gratuit de {trialDays} jours</b>
              <p className="muted">Connectez Stripe, activez les relances et mesurez le revenu récupéré avant de choisir un tarif.</p>
              <a href="/login" className="btn btn-p">Commencer</a>
            </div>
          )}
        </Section>

        <Section id="faq" title="Questions fréquentes">
          <div className="panel" style={{ padding: '0 28px', maxWidth: 840 }}>
            {FAQ.map((f, i) => (
              <details key={f.q} className="m-faq" style={{ borderTop: i === 0 ? 0 : '1px solid var(--line)' }}>
                <summary>{f.q}</summary>
                <p className="muted" style={{ padding: '0 48px 22px 0', lineHeight: 1.6 }}>{f.a}</p>
              </details>
            ))}
          </div>
        </Section>

        <section className="m-final" aria-label="Commencer">
          <div className="m-in row wrap" style={{ gap: 32, justifyContent: 'space-between' }}>
            <p className="m-final-title">Votre prochain paiement refusé peut déjà être récupéré.</p>
            <a href="/login" className="btn btn-lg" style={{ background: '#fff', color: 'var(--blue-hover)' }}>Connecter mon Stripe</a>
          </div>
        </section>
      </main>

      <footer className="m-footer">
        <div className="m-in row wrap" style={{ gap: 32, justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ maxWidth: 280 }}><div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>RecoverKit</div>La récupération des paiements Stripe pour les fondateurs de SaaS.</div>
          <nav aria-label="Pied de page" className="row wrap" style={{ gap: 48, alignItems: 'flex-start' }}>
            <div className="stack" style={{ gap: 10 }}><b style={{ color: 'var(--ink)' }}>Produit</b><a href="#fonctionnement">Fonctionnement</a><a href="#tarifs">Tarifs</a><a href="#faq">Questions fréquentes</a></div>
            <div className="stack" style={{ gap: 10 }}><b style={{ color: 'var(--ink)' }}>Société</b><a href="/mentions-legales">Mentions légales</a><a href="/confidentialite">Confidentialité</a><a href="/login">Se connecter</a></div>
          </nav>
        </div>
      </footer>
    </div>
  );
}
