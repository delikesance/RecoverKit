# Runbook d'exploitation

## Processus
| Processus | Commande | Rôle |
|---|---|---|
| web (l'image Docker lance les trois) | `npm start --workspace @recoverkit/web` | site, app fondateur, pages client, webhooks |
| worker | `npm start --workspace @recoverkit/worker` | inbox des webhooks, envois, clôtures, digests, facturation, rétention |
| migrations | `npm run db:migrate` | à lancer avant chaque déploiement (compatibles avec l'ancienne version : ajouter avant de supprimer) |

Variables : voir `packages/services/src/config.ts` (`DATABASE_URL`, `APP_URL`, clés Stripe et Resend, `TOKEN_SECRET`, `PLANS`, …). Ne jamais définir `RECOVERKIT_E2E` en production.

## Image Docker tout-en-un
Publiée par `.github/workflows/docker.yml` sur `ghcr.io/<propriétaire>/<dépôt>` (`latest` sur `main`, `sha-…`, versions `v*`). Elle contient PostgreSQL 16, le site et le worker, supervisés par `docker/entrypoint.sh`.

```bash
docker run -d --name recoverkit -p 8080:3000 -v recoverkit-data:/var/lib/postgresql/data \
  -e APP_URL=https://app.exemple.fr -e STRIPE_SECRET_KEY=… -e STRIPE_CONNECT_WEBHOOK_SECRET=… \
  -e STRIPE_PLATFORM_WEBHOOK_SECRET=… -e STRIPE_CONNECT_CLIENT_ID=… -e STRIPE_PUBLISHABLE_KEY=… \
  -e RESEND_API_KEY=… -e SYSTEM_FROM_EMAIL=… -e TOKEN_SECRET=… ghcr.io/<propriétaire>/<dépôt>:latest
```
- **Un seul port : 3000, HTTP.** Le HTTPS se termine sur votre reverse proxy, qui doit transmettre `Host`, `Origin` et `X-Forwarded-For` tels quels. `APP_URL` doit être l'URL publique en `https://`.
- **Volume obligatoire** sur `/var/lib/postgresql/data` : sans lui, la base disparaît avec le conteneur. Il contient aussi le mot de passe interne de la base et, à défaut de `TOKEN_SECRET` fourni, un secret généré (à fournir explicitement en production).
- PostgreSQL n'écoute que sur `127.0.0.1` dans le conteneur. Les migrations s'appliquent à chaque démarrage. Une seule instance par volume.
- Sauvegarde : `docker exec recoverkit pg_dump -h /tmp -U postgres recoverkit > sauvegarde.sql`.
- Si la base, le site ou le worker s'arrête, le conteneur s'arrête (utiliser `--restart unless-stopped`).

## Santé
- `GET /api/health` : 200 si la base répond, 503 sinon (sonde de disponibilité).
- `GET /api/health/details` avec l'en-tête `Authorization: Bearer $ADMIN_TOKEN` : retard de l'inbox, étapes en retard, évènements `dead`, alertes ouvertes.

## Incidents
**Webhooks Stripe en retard ou en erreur**
1. `/api/health/details` : regarder `inbox.pending` et `inbox.dead`.
2. Worker arrêté ? Le relancer : l'inbox reprend dans l'ordre (`seq`), sans doublon (`stripe_event_id` unique).
3. Évènements `dead` : corriger la cause, puis `npm run replay --workspace @recoverkit/worker -- <event_id>`.

**Soupçon d'écart avec Stripe** (évènement perdu) : `npm run reconcile --workspace @recoverkit/worker`. La réconciliation compare les factures impayées de chaque compte actif aux dossiers et corrige les écarts ; elle tourne aussi chaque nuit.

**Étapes d'email en retard** : vérifier que le worker tourne, puis `scheduled_steps` en `SENDING` depuis plus de 10 minutes (reprises automatiquement avec la même clé d'idempotence, donc sans doublon d'email).

**Doublon d'email signalé** : ne pas renvoyer à la main. Chercher `email_messages.idempotency_key` (`<dossier>:<étape>`) : elle est unique. Consulter `action_log` du dossier.

**Compte fondateur déconnecté de Stripe** : la connexion passe en `REVOKED`, les étapes planifiées sont annulées et une alerte est affichée. Le fondateur se reconnecte depuis l'onboarding ; rien n'est dupliqué.

**Plainte spam / rebond** : l'adresse est ajoutée à la liste de suppression automatiquement ; vérifier `suppressions`.

## Données
- `action_log` et `recovery_ledger` sont en ajout seul (triggers). Une correction passe par une ligne `ADJUSTMENT`, jamais par un UPDATE.
- Purge de rétention (18 mois) et suppression de compte : voir `packages/services/src/compliance`. Seules ces fonctions activent `recoverkit.allow_purge`.
- Sauvegardes : snapshots PostgreSQL quotidiens, test de restauration mensuel.

## Checklist de mise en production
- [ ] `APP_URL` en HTTPS, `TOKEN_SECRET` ≥ 32 caractères aléatoires, secrets de webhook Stripe (Connect et plateforme) distincts.
- [ ] `STRIPE_PUBLISHABLE_KEY` renseignée (sinon la page de paiement client ne peut pas afficher de formulaire de carte).
- [ ] Domaine d'envoi vérifié chez Resend (SPF, DKIM, DMARC) ; `RESEND_WEBHOOK_SECRET` défini.
- [ ] `PLANS` renseigné, correspondant aux prix Stripe de la plateforme.
- [ ] Mentions légales et politique de confidentialité complétées (`apps/web/src/app/mentions-legales`, `confidentialite`).
- [ ] `RECOVERKIT_E2E` absent. `ADMIN_TOKEN` défini.
- [ ] Parcours manuel en mode test Stripe : `stripe listen --forward-to <APP_URL>/api/stripe/webhook`, `stripe trigger invoice.payment_failed`, email en dry-run puis réel vers une boîte de test, carte `4242 4242 4242 4242` sur `/pay/…`, vérifier `invoice.paid` → dossier `RECOVERED` + ligne au ledger. (Non réalisé dans cet environnement : Stripe.js réel et 3-D Secure ne sont pas couverts par les tests automatiques.)
