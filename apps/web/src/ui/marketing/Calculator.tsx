'use client';

import { useId, useState } from 'react';
import { CALCULATOR_DEFAULTS, estimateRecovery } from '@recoverkit/core';

const euros = (n: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);

export function Calculator() {
  const id = useId();
  const [mrr, setMrr] = useState(CALCULATOR_DEFAULTS.mrr);
  const [failRate, setFailRate] = useState(CALCULATOR_DEFAULTS.failRate);
  const [recoveryRate, setRecoveryRate] = useState(CALCULATOR_DEFAULTS.recoveryRate);
  const r = estimateRecovery({ mrr, failRate, recoveryRate });

  return (
    <div className="panel m-calc">
      <div className="m-calc-inputs">
        <div>
          <label htmlFor={`${id}-mrr`} className="m-calc-label"><span>Revenu mensuel récurrent</span><span className="num">{euros(mrr)}</span></label>
          <input id={`${id}-mrr`} type="range" min={2000} max={200000} step={1000} value={mrr} onChange={(e) => setMrr(Number(e.target.value))} />
        </div>
        <div>
          <label htmlFor={`${id}-fail`} className="m-calc-label"><span>Part des paiements qui échouent</span><span className="num">{failRate} %</span></label>
          <input id={`${id}-fail`} type="range" min={1} max={15} step={1} value={failRate} onChange={(e) => setFailRate(Number(e.target.value))} />
        </div>
        <div>
          <label htmlFor={`${id}-rec`} className="m-calc-label"><span>Part récupérée (hypothèse)</span><span className="num">{recoveryRate} %</span></label>
          <input id={`${id}-rec`} type="range" min={10} max={80} step={5} value={recoveryRate} onChange={(e) => setRecoveryRate(Number(e.target.value))} />
        </div>
        <p className="muted" style={{ fontSize: 13 }}>Le résultat est une estimation fondée sur vos hypothèses, pas une promesse.</p>
      </div>
      <div className="m-calc-result" aria-live="polite">
        <div className="muted" style={{ fontSize: 14, fontWeight: 500 }}>Revenu récupérable par an</div>
        <div className="m-calc-total num" data-testid="year-total">{euros(r.recoveredPerYear)}</div>
        <div className="kv"><span>Perdu chaque mois</span><b className="num" data-testid="month-lost">{euros(r.lostPerMonth)}</b></div>
        <div className="kv"><span>Récupérable chaque mois</span><b className="num" data-testid="month-recovered">{euros(r.recoveredPerMonth)}</b></div>
        <a href="/login" className="btn btn-p btn-lg" style={{ width: '100%', marginTop: 20 }}>Récupérer cet argent</a>
      </div>
    </div>
  );
}
