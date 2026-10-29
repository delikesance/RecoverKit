-- Purge RGPD : index pour retrouver vite les payloads Stripe d'un tenant / d'un compte et les jetons expirés.
create index if not exists inbox_events_tenant_idx on inbox_events (tenant_id);
create index if not exists inbox_events_account_idx on inbox_events (stripe_account_id);
create index if not exists inbox_events_received_idx on inbox_events (received_at) where status in ('processed','ignored','dead');
create index if not exists login_tokens_expires_idx on login_tokens (expires_at);
