-- dédoublonnage des webhooks du fournisseur d'email (identifiant svix-id)
create table provider_events (
  id text primary key,
  received_at timestamptz not null default now()
);
