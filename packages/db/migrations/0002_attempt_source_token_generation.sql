-- origine d'une tentative de paiement : lien de mise à jour (link) ou changement de carte détecté (webhook)
alter table payment_attempts add column source text not null default 'webhook' check (source in ('link', 'webhook'));
-- génération du token dérivé d'un dossier (rotation possible sans stocker le token en clair)
alter table payment_tokens add column generation int not null default 1;
