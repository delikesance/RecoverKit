-- Ordre des évènements de facturation plateforme : un évènement plus ancien que le dernier appliqué est ignoré.
alter table billing_subscriptions add column last_event_at timestamptz;
