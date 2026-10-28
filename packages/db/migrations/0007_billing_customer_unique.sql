-- un client Stripe de facturation correspond à un seul tenant
create unique index billing_subscriptions_customer_idx on billing_subscriptions (stripe_customer_id) where stripe_customer_id is not null;
