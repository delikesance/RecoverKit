import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const DB = 'rk_e2e';
const URL = `http://localhost:${PORT}`;
export const E2E_TOKEN = 'e2e-secret-token';

const env = {
  NODE_ENV: 'production',
  RECOVERKIT_E2E: '1',
  E2E_TOKEN,
  DATABASE_URL: `postgresql://recoverkit:recoverkit@localhost:5432/${DB}`,
  APP_URL: URL,
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect_e2e',
  STRIPE_PLATFORM_WEBHOOK_SECRET: 'whsec_platform_e2e',
  STRIPE_CONNECT_CLIENT_ID: 'ca_e2e',
  STRIPE_PUBLISHABLE_KEY: 'pk_fake_e2e',
  RESEND_API_KEY: 're_fake',
  SYSTEM_FROM_EMAIL: 'no-reply@recoverkit.test',
  TOKEN_SECRET: 'e2e-token-secret-e2e-token-secret-0123456789',
  LOG_LEVEL: 'silent',
};

const prepare = [
  `psql postgresql://recoverkit:recoverkit@localhost:5432/postgres -v ON_ERROR_STOP=1 -c "drop database if exists ${DB} with (force)" -c "create database ${DB}"`,
  `for f in ../../packages/db/migrations/*.sql; do psql ${env.DATABASE_URL} -v ON_ERROR_STOP=1 -q -f "$f" || exit 1; done`,
  `npx next start -p ${PORT}`,
].join(' && ');

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: URL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', testMatch: /pay\.spec\.ts|landing\.spec\.ts/, use: { ...devices['Pixel 7'] } },
  ],
  webServer: { command: prepare, url: `${URL}/api/health`, timeout: 120_000, reuseExistingServer: false, env },
});
