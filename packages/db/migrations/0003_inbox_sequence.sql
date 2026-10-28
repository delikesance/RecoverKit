-- ordre d'arrivée strict (FIFO) pour le traitement des webhooks
alter table inbox_events add column seq bigserial;
create index inbox_events_seq_idx on inbox_events (seq) where status = 'pending';
