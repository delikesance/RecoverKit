import { Money, partsInZone, zonedToUtc, type LedgerEntry } from '@recoverkit/core';
import type { Deps } from '../deps';

/** Semaine ISO (AAAA-Www) de l'instant donné, dans le fuseau du tenant. */
export function isoWeekOf(date: Date, timeZone: string): string {
  const p = partsInZone(date, timeZone);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const dayNum = (d.getUTCDay() + 6) % 7; // lundi = 0
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // jeudi de la semaine
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

const STR = {
  fr: {
    subject: (name: string, amount: string) => `Votre semaine sur ${name} : ${amount} récupérés`,
    recovered: (amount: string) => `Revenu récupéré : ${amount}`,
    saved: (n: number) => `${n} client${n > 1 ? 's' : ''} sauvé${n > 1 ? 's' : ''}`,
    atRisk: (amount: string, n: number) => `Encore à risque : ${amount} sur ${n} paiement${n > 1 ? 's' : ''}`,
    open: 'Ouvrir le tableau de bord',
    hello: 'Bonjour,',
    intro: (name: string) => `Voici le récapitulatif de la semaine passée pour ${name}.`,
  },
  en: {
    subject: (name: string, amount: string) => `Your weekly summary for ${name}: ${amount} recovered`,
    recovered: (amount: string) => `Revenue recovered: ${amount}`,
    saved: (n: number) => `${n} customer${n > 1 ? 's' : ''} saved`,
    atRisk: (amount: string, n: number) => `Still at risk: ${amount} across ${n} payment${n > 1 ? 's' : ''}`,
    open: 'Open the dashboard',
    hello: 'Hi,',
    intro: (name: string) => `Here is last week's summary for ${name}.`,
  },
};

/** Envoie le récapitulatif hebdomadaire (lundi 8 h locale ou rattrapage dans la semaine), une fois par semaine ISO. */
export async function runWeeklyDigests(deps: Deps): Promise<{ sent: number; skipped: number }> {
  const now = deps.clock.now();
  const tenants = await deps.pool.query(
    `select t.id, t.name, t.time_zone, t.locale, u.email from tenants t join users u on u.tenant_id = t.id
      where t.status = 'ACTIVE' and t.digest_enabled = true`,
  );
  let sent = 0;
  let skipped = 0;

  for (const t of tenants.rows) {
    const local = partsInZone(now, t.time_zone);
    const weekday = (new Date(Date.UTC(local.y, local.m - 1, local.d)).getUTCDay() + 6) % 7;
    if (weekday === 0 && local.h < 8) {
      skipped++;
      continue;
    }
    const week = isoWeekOf(now, t.time_zone);
    const already = await deps.pool.query(`select 1 from digests where tenant_id = $1 and iso_week = $2`, [t.id, week]);
    if ((already.rowCount ?? 0) > 0) continue;

    // semaine passée : du lundi précédent 00:00 au lundi courant 00:00 (heure locale)
    const monday = new Date(Date.UTC(local.y, local.m - 1, local.d - weekday));
    const prevMonday = new Date(monday.getTime() - 7 * 86400_000);
    const end = zonedToUtc(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), 0, 0, t.time_zone);
    const start = zonedToUtc(prevMonday.getUTCFullYear(), prevMonday.getUTCMonth() + 1, prevMonday.getUTCDate(), 0, 0, t.time_zone);

    const rows = await deps.pool.query(
      `select * from recovery_ledger where tenant_id = $1 and occurred_at >= $2 and occurred_at < $3`,
      [t.id, start, end],
    );
    const entries: LedgerEntry[] = rows.rows.map((r) => ({
      caseId: r.case_id, invoiceId: r.invoice_id, kind: r.kind, attribution: r.attribution,
      amount: Money.of(Number(r.amount), r.currency), occurredAt: r.occurred_at,
    }));
    const byCurrency = new Map<string, { recovered: number; cases: Set<string> }>();
    for (const e of entries) {
      if (e.attribution !== 'ASSISTED') continue;
      const cur = byCurrency.get(e.amount.currency) ?? { recovered: 0, cases: new Set<string>() };
      cur.recovered += e.amount.amount;
      if (e.kind === 'RECOVERY') cur.cases.add(e.caseId);
      byCurrency.set(e.amount.currency, cur);
    }
    const risk = await deps.pool.query(
      `select currency, sum(amount_due)::bigint as amount, count(*)::int as n from recovery_cases
        where tenant_id = $1 and state in ('OPEN','RECOVERING','PAUSED') group by currency`,
      [t.id],
    );
    const currencies = [...new Set([...byCurrency.keys(), ...risk.rows.map((r) => r.currency)])].sort();
    // Rien à dire (ex. uniquement du NATURAL, aucun dossier à risque) : pas d'email vide.
    if (currencies.length === 0) {
      skipped++;
      continue;
    }

    const claimed = await deps.pool.query(
      `insert into digests (tenant_id, iso_week, sent_at) values ($1,$2,$3) on conflict do nothing returning iso_week`,
      [t.id, week, now],
    );
    if (claimed.rowCount !== 1) continue;

    const L = STR[t.locale === 'en' ? 'en' : 'fr'];
    const locale = t.locale === 'en' ? 'en-US' : 'fr-FR';
    const lines: string[] = [];
    // Titre : la devise qui a le plus récupéré ; à défaut, la première devise à risque.
    const top = currencies
      .filter((c) => (byCurrency.get(c)?.recovered ?? 0) > 0)
      .sort((a, b) => byCurrency.get(b)!.recovered - byCurrency.get(a)!.recovered)[0];
    const headCurrency = top ?? currencies[0]!;
    let headline = '';
    for (const c of currencies) {
      const rec = byCurrency.get(c);
      const rk = risk.rows.find((r) => r.currency === c);
      const amount = Money.of(rec?.recovered ?? 0, c).format(locale);
      if (c === headCurrency) headline = amount;
      lines.push(L.recovered(amount));
      if (rec && rec.cases.size > 0) lines.push(L.saved(rec.cases.size));
      if (rk) lines.push(L.atRisk(Money.of(Number(rk.amount), c).format(locale), rk.n));
    }
    const link = `${deps.config.appUrl}/app`;
    const text = `${L.hello}\n\n${L.intro(t.name)}\n\n${lines.join('\n')}\n\n${L.open} : ${link}\n`;
    const html = `<p>${L.hello}</p><p>${L.intro(t.name)}</p><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul><p><a href="${link}">${L.open}</a></p>`;
    try {
      await deps.mailer.send({
        to: t.email,
        from: { name: 'RecoverKit', email: deps.config.systemFromEmail },
        subject: L.subject(t.name, headline),
        text,
        html,
        idempotencyKey: `digest:${t.id}:${week}`,
      });
      sent++;
    } catch (e) {
      await deps.pool.query(`delete from digests where tenant_id = $1 and iso_week = $2`, [t.id, week]);
      deps.log.warn({ tenantId: t.id, err: (e as Error).message }, 'envoi du récapitulatif hebdomadaire impossible');
    }
  }
  return { sent, skipped };
}
