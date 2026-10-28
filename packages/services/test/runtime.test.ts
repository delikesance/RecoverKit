import { afterAll, describe, expect, it } from 'vitest';
import { ResendDomainProvider, ResendMailer } from '@recoverkit/mail';
import { StripeSdkBillingGateway, StripeSdkGateway } from '@recoverkit/stripe';
import { createRuntime } from '../src/runtime';
import { TEST_ENV } from './helpers';

const env = { ...TEST_ENV, DATABASE_URL: 'postgresql://recoverkit:recoverkit@localhost:5432/postgres' };
const runtimes: { close(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(runtimes.map((r) => r.close()));
});

describe('createRuntime', () => {
  it('assemble les adaptateurs réels à partir de la configuration', () => {
    const rt = createRuntime(env);
    runtimes.push(rt);
    expect(rt.deps.mailer).toBeInstanceOf(ResendMailer);
    expect(rt.deps.domains).toBeInstanceOf(ResendDomainProvider);
    expect(rt.deps.stripe).toBeInstanceOf(StripeSdkGateway);
    expect(rt.deps.billing).toBeInstanceOf(StripeSdkBillingGateway);
    expect(rt.deps.config.appUrl).toBe('https://app.recoverkit.test');
    expect(rt.deps.clock.now().getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('échoue clairement quand la configuration est incomplète', () => {
    expect(() => createRuntime({})).toThrow(/Configuration invalide/);
  });

  it('se connecte à la base et se ferme proprement', async () => {
    const rt = createRuntime(env);
    const res = await rt.deps.pool.query('select 1 as one');
    expect(res.rows[0].one).toBe(1);
    await rt.close();
  });
});
