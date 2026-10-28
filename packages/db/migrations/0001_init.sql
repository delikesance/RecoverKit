-- RecoverKit : schéma initial

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  time_zone text not null default 'Europe/Paris',
  locale text not null default 'fr' check (locale in ('fr', 'en')),
  support_email text,
  sender_name text,
  sender_email text,
  reply_to text,
  send_start_hour int not null default 9 check (send_start_hour between 0 and 23),
  send_end_hour int not null default 19 check (send_end_hour between 1 and 24),
  emails_enabled boolean not null default true,
  dry_run boolean not null default true,
  digest_enabled boolean not null default true,
  onboarding jsonb not null default '{}'::jsonb,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'DELETED')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references tenants (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);
create unique index users_email_lower_idx on users (lower(email));

create table login_tokens (
  token_hash text primary key,
  email text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  tenant_id uuid not null references tenants (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table stripe_connections (
  tenant_id uuid primary key references tenants (id) on delete cascade,
  stripe_account_id text not null unique,
  status text not null check (status in ('PENDING', 'ACTIVE', 'REVOKED')),
  livemode boolean not null default false,
  connected_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table oauth_states (
  state_hash text primary key,
  session_id uuid not null references sessions (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table inbox_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  stripe_account_id text,
  tenant_id uuid references tenants (id) on delete set null,
  type text not null,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'processed', 'ignored', 'dead')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index inbox_events_pending_idx on inbox_events (next_attempt_at) where status = 'pending';

create table end_customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  stripe_customer_id text not null,
  email text,
  name text,
  locale text,
  created_at timestamptz not null default now(),
  anonymized_at timestamptz,
  unique (tenant_id, stripe_customer_id)
);

create table sequences (
  tenant_id uuid not null references tenants (id) on delete cascade,
  version int not null,
  steps jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, version)
);

create table email_templates (
  tenant_id uuid not null references tenants (id) on delete cascade,
  step_index int not null,
  locale text not null check (locale in ('fr', 'en')),
  subject text not null,
  body text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, step_index, locale)
);

create table recovery_cases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  stripe_invoice_id text not null,
  stripe_customer_id text,
  stripe_subscription_id text,
  end_customer_id uuid references end_customers (id) on delete set null,
  state text not null default 'OPEN'
    check (state in ('OPEN', 'RECOVERING', 'PAUSED', 'RECOVERED', 'CANCELED', 'LOST', 'CLOSED_MANUAL')),
  amount_due bigint not null check (amount_due >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  plan_name text,
  attempt_count int not null default 1,
  last_failure_code text,
  failed_at timestamptz not null,
  sequence_version int,
  close_reason text,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, stripe_invoice_id)
);
create index recovery_cases_tenant_state_idx on recovery_cases (tenant_id, state);

create table scheduled_steps (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references recovery_cases (id) on delete cascade,
  tenant_id uuid not null references tenants (id) on delete cascade,
  step_index int not null,
  due_at timestamptz not null,
  status text not null default 'SCHEDULED'
    check (status in ('SCHEDULED', 'SENDING', 'SENT', 'SKIPPED', 'FAILED', 'CANCELED')),
  skip_reason text,
  attempts int not null default 0,
  reserved_at timestamptz,
  sent_at timestamptz,
  message_id text,
  created_at timestamptz not null default now(),
  unique (case_id, step_index)
);
create index scheduled_steps_due_idx on scheduled_steps (due_at) where status = 'SCHEDULED';
create index scheduled_steps_sending_idx on scheduled_steps (reserved_at) where status = 'SENDING';

create table email_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  case_id uuid not null references recovery_cases (id) on delete cascade,
  step_index int not null,
  idempotency_key text not null unique,
  provider_message_id text,
  to_email text not null,
  subject text not null,
  status text not null default 'SENT'
    check (status in ('SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED')),
  dry_run boolean not null default false,
  sent_at timestamptz not null default now(),
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz
);
create index email_messages_provider_idx on email_messages (provider_message_id);

create table suppressions (
  tenant_id uuid not null references tenants (id) on delete cascade,
  email text not null,
  reason text not null check (reason in ('UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, email)
);

create table payment_tokens (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references recovery_cases (id) on delete cascade,
  tenant_id uuid not null references tenants (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  first_opened_at timestamptz,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
-- jamais deux liens actifs pour un même dossier
create unique index payment_tokens_one_active_idx
  on payment_tokens (case_id) where used_at is null and revoked_at is null;

create table payment_attempts (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references recovery_cases (id) on delete cascade,
  tenant_id uuid not null references tenants (id) on delete cascade,
  payment_method_id text not null,
  status text not null check (status in ('PENDING', 'SUCCEEDED', 'FAILED', 'REQUIRES_ACTION')),
  error_code text,
  created_at timestamptz not null default now(),
  unique (case_id, payment_method_id)
);

create table action_log (
  id bigserial primary key,
  tenant_id uuid,
  case_id uuid,
  actor text not null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index action_log_case_idx on action_log (case_id, id);
create index action_log_tenant_idx on action_log (tenant_id, id);

create table recovery_ledger (
  id bigserial primary key,
  tenant_id uuid not null,
  case_id uuid not null,
  invoice_id text not null,
  kind text not null check (kind in ('RECOVERY', 'ADJUSTMENT')),
  attribution text not null check (attribution in ('ASSISTED', 'NATURAL')),
  amount bigint not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz not null,
  rule_version int not null default 1,
  stripe_event_id text,
  created_at timestamptz not null default now()
);
create index recovery_ledger_tenant_idx on recovery_ledger (tenant_id, occurred_at);
-- une seule ligne RECOVERY par facture : garantit l'idempotence du rejeu
create unique index recovery_ledger_one_recovery_idx
  on recovery_ledger (tenant_id, invoice_id) where kind = 'RECOVERY';

-- Append-only : interdit UPDATE/DELETE, sauf purge RGPD explicite (SET LOCAL recoverkit.allow_purge = 'on')
create function forbid_mutation() returns trigger language plpgsql as $$
begin
  if current_setting('recoverkit.allow_purge', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'La table % est en ajout seul (% interdit)', tg_table_name, tg_op;
end;
$$;
create trigger action_log_append_only before update or delete on action_log
  for each row execute function forbid_mutation();
create trigger recovery_ledger_append_only before update or delete on recovery_ledger
  for each row execute function forbid_mutation();

create table rate_limits (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);

create table digests (
  tenant_id uuid not null references tenants (id) on delete cascade,
  iso_week text not null,
  sent_at timestamptz not null default now(),
  primary key (tenant_id, iso_week)
);

create table billing_subscriptions (
  tenant_id uuid primary key references tenants (id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  plan text,
  status text not null default 'NONE'
    check (status in ('NONE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  past_due_since timestamptz,
  mrr_amount bigint,
  mrr_currency text,
  mrr_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

create table system_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants (id) on delete cascade,
  kind text not null,
  dedupe_key text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index system_alerts_open_dedupe_idx on system_alerts (dedupe_key) where resolved_at is null;
