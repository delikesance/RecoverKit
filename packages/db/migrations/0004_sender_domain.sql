-- expéditeur personnalisé : l'adresse n'est utilisée qu'une fois le domaine vérifié chez le fournisseur d'email
alter table tenants
  add column sender_verified boolean not null default false,
  add column sender_domain text,
  add column sender_domain_id text;
