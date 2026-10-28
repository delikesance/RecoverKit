-- une alerte n'est envoyée par email au fondateur qu'une seule fois
alter table system_alerts add column notified_at timestamptz;
