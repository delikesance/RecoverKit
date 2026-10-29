'use client';

import { useEffect, useRef, useState } from 'react';
import { loadStripe, type Stripe, type StripeElements } from '@stripe/stripe-js';

export interface PayFormProps {
  token: string;
  locale: 'fr' | 'en';
  amount: string;
  tenantName: string;
  publishableKey: string;
  account: string;
}

const T = {
  fr: { card: 'Carte bancaire', cta: (a: string) => `Mettre à jour et payer ${a}`, busy: 'Traitement…', secure: 'Paiement sécurisé par Stripe. Vos données de carte ne transitent pas par nos serveurs.', fakeNumber: 'Numéro de carte (mode test)', loading: 'Chargement du formulaire sécurisé…', retry: 'Réessayer', failed: 'Impossible de préparer le paiement. Rien n’a été débité. Réessayez dans un instant.' },
  en: { card: 'Card', cta: (a: string) => `Update and pay ${a}`, busy: 'Processing…', secure: 'Secure payment by Stripe. Your card details never touch our servers.', fakeNumber: 'Card number (test mode)', loading: 'Loading the secure form…', retry: 'Try again', failed: 'We could not prepare the payment. Nothing was charged. Please try again shortly.' },
} as const;

export function PayForm(p: PayFormProps) {
  const t = T[p.locale];
  const fake = p.publishableKey === 'pk_fake_e2e';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [number, setNumber] = useState('');
  const [ready, setReady] = useState(fake);
  const [attempt, setAttempt] = useState(0);
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const clientSecret = useRef<string | null>(null);

  useEffect(() => {
    if (fake) return;
    let cancelled = false;
    setReady(false);
    (async () => {
      const res = await fetch(`/api/pay/${p.token}/setup`, { method: 'POST' });
      if (!res.ok) { if (!cancelled) setError(t.failed); return; }
      const data = await res.json();
      const stripe = await loadStripe(data.publishableKey, { stripeAccount: data.account, locale: p.locale });
      if (cancelled || !stripe || !mountRef.current) return;
      stripeRef.current = stripe;
      clientSecret.current = data.clientSecret;
      const elements = stripe.elements({ clientSecret: data.clientSecret, locale: p.locale });
      elementsRef.current = elements;
      elements.create('payment').mount(mountRef.current);
      setReady(true);
    })().catch(() => !cancelled && setError(t.failed));
    return () => { cancelled = true; };
  }, [fake, p.token, p.locale, t.failed, attempt]);

  function retry() {
    setError(null);
    setAttempt((n) => n + 1);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      if (fake) {
        const res = await fetch(`/api/pay/${p.token}/fake-complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number }) });
        const data = await res.json();
        if (!res.ok) throw new Error('fake');
        window.location.assign(`/pay/${p.token}/return?setup_intent=${encodeURIComponent(data.setupIntentId)}`);
        return; // reste occupé : la page est en train de changer
      }
      const stripe = stripeRef.current;
      const elements = elementsRef.current;
      if (!stripe || !elements) throw new Error('not_ready');
      const { error: err } = await stripe.confirmSetup({ elements, confirmParams: { return_url: `${window.location.origin}/pay/${p.token}/return` } });
      if (err) {
        setError(err.message ?? t.failed);
        setBusy(false);
      }
      // sans erreur, Stripe redirige vers la page de retour : le bouton reste occupé
    } catch {
      setError(t.failed);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      {fake ? (
        <>
          <label className="label" htmlFor="fake-card-number">{t.fakeNumber}</label>
          <input id="fake-card-number" className="field field-lg" inputMode="numeric" autoComplete="cc-number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="4242 4242 4242 4242" />
        </>
      ) : (
        <>
          <span className="label" id="card-label">{t.card}</span>
          <div ref={mountRef} role="group" aria-labelledby="card-label" aria-busy={!ready} style={{ minHeight: ready ? undefined : 48 }} />
          {!ready && !error ? <p className="muted" role="status" style={{ marginTop: 8, fontSize: 14 }}>{t.loading}</p> : null}
        </>
      )}
      {error ? <div className="banner banner-critical" role="alert" style={{ marginTop: 16 }}><span className="grow">{error}</span></div> : null}
      {!fake && !ready && error ? <button type="button" className="btn btn-s" style={{ width: '100%', marginTop: 12 }} onClick={retry}>{t.retry}</button> : null}
      <button type="submit" className="btn btn-p btn-lg" style={{ width: '100%', marginTop: 20, minHeight: 50 }} disabled={busy || !ready}>
        {busy ? t.busy : t.cta(p.amount)}
      </button>
      <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>{t.secure}</p>
    </form>
  );
}
