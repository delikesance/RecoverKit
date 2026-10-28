import { signStripePayload, stripeEvent } from '@recoverkit/testkit/events';
import {
  closeExhaustedCases,
  notifyFounderAlerts,
  processInbox,
  receiveStripeWebhook,
  runDueSteps,
} from '@recoverkit/services';
import { e2eAllowed } from '../e2e-guard';
import { jsonResponse } from '../http';
import type { WebRuntime } from '../runtime';

const NOT_FOUND = () => jsonResponse({ error: 'not_found' }, 404);

/** Pilotage des adaptateurs factices pour les tests de bout en bout. Inexistant hors mode E2E. */
export async function handleE2E(rt: WebRuntime, req: Request, action: string, env: Record<string, string | undefined>): Promise<Response> {
  if (!e2eAllowed(env, req) || !rt.e2e) return NOT_FOUND();
  const { deps, e2e } = rt;
  const body: any = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  switch (action) {
    case 'mailbox':
      return jsonResponse({ emails: e2e.mailer.sent });
    case 'clock': {
      if (body.advanceMinutes !== undefined) e2e.clock.advance({ minutes: Number(body.advanceMinutes) });
      if (body.set !== undefined) {
        const d = new Date(body.set);
        if (Number.isNaN(d.getTime())) return jsonResponse({ error: 'invalid_date' }, 400);
        e2e.clock.set(d);
      }
      return jsonResponse({ now: e2e.clock.now().toISOString() });
    }
    case 'events': {
      const evt = stripeEvent(body.type, body.object ?? {}, { account: body.account, created: e2e.clock.now(), previousAttributes: body.previous });
      const raw = JSON.stringify(evt);
      const res = await receiveStripeWebhook(deps, {
        rawBody: raw,
        signature: signStripePayload(raw, deps.config.stripeConnectWebhookSecret, e2e.clock.now()),
      });
      return jsonResponse({ eventId: evt.id, result: res.status }, res.httpStatus);
    }
    case 'worker': {
      const inbox = await processInbox(deps);
      const steps = await runDueSteps(deps);
      const exhausted = await closeExhaustedCases(deps);
      const alerts = await notifyFounderAlerts(deps);
      return jsonResponse({ inbox, steps, exhausted, alerts });
    }
    case 'stripe':
      return handleStripeOp(e2e.stripe, body);
    case 'fake-card': {
      e2e.stripe.setCardBehavior(body.paymentMethodId, body.behavior ?? 'succeed', body.code);
      e2e.stripe.completeSetupIntent(body.account, body.setupIntentId, body.paymentMethodId);
      return jsonResponse({ ok: true });
    }
    default:
      return NOT_FOUND();
  }
}

function handleStripeOp(stripe: NonNullable<WebRuntime['e2e']>['stripe'], b: any): Response {
  switch (b.op) {
    case 'addCustomer':
      stripe.addCustomer(b.account, b.customer);
      break;
    case 'addSubscription':
      stripe.addSubscription(b.account, b.subscription);
      break;
    case 'addInvoice':
      stripe.addInvoice(b.account, b.invoice);
      break;
    case 'markPaid':
      stripe.markPaid(b.account, b.invoiceId);
      break;
    case 'setCardBehavior':
      stripe.setCardBehavior(b.paymentMethodId, b.behavior, b.code);
      break;
    case 'setOAuthCode':
      stripe.setOAuthCode(b.code, { stripeUserId: b.stripeUserId, livemode: !!b.livemode });
      break;
    default:
      return jsonResponse({ error: 'unknown_op' }, 400);
  }
  return jsonResponse({ ok: true });
}
