# Décisions d'architecture (autonomes)

Source : plan d'implémentation. Toute nouvelle ambiguïté est tranchée ici, jamais posée à l'utilisateur.

| # | Sujet | Décision |
|---|---|---|
| D1 | Connexion Stripe | Stripe Connect Standard (OAuth). On stocke `stripe_account_id` ; appels avec la clé plateforme + en-tête `Stripe-Account`. Aucune clé client stockée. |
| D2 | Revenu récupéré | `ASSISTED` (payé après au moins un email RecoverKit envoyé ou lien utilisé) = chiffre principal ; `NATURAL` affiché à part, jamais compté. |
| D3 | Séquence par défaut | +1 h, +3 j, +7 j, +12 j ; fenêtre 9 h à 19 h heure locale du tenant ; retry à chaque carte mise à jour et la veille du dernier avis. |
| D4 | Factures concernées | Abonnements uniquement (`invoice.subscription` non nul). |
| D5 | Langues | Emails et pages client FR + EN. Dashboard FR. |
| D6 | Prix RecoverKit | Abonnement fixe par palier de MRR, prix en config (`PLANS`). Dépassement de palier = bandeau, pas de blocage. |
| D7 | Stack | TypeScript strict, npm workspaces, Next.js App Router, worker Node séparé, PostgreSQL 16 + SQL migrations, Zod, Vitest, Playwright, Tailwind, Resend. |
| D8 | File de tâches | Tables Postgres + `FOR UPDATE SKIP LOCKED`. Pas de Redis. |
| D9 | Auth fondateur | Lien magique par email, session cookie HttpOnly/SameSite=Lax. Un utilisateur par tenant. |
| D10 | Données client final | Snapshot minimal (email, nom, langue). Purge 18 mois après clôture. |
| D11 | Git | `git init` fait. Aucun commit/push sans demande explicite de l'utilisateur. |

## Adaptations d'environnement

- Pas de démon Docker dans l'environnement de développement actuel : les tests d'intégration utilisent le PostgreSQL 16 local (`postgresql://recoverkit:recoverkit@localhost:5432`). `docker-compose.yml` reste fourni pour les autres environnements et la CI.
- Pas de `stripe-mock` disponible hors Docker : l'adaptateur Stripe réel est testé contre un serveur HTTP local qui imite l'API (en-têtes, paramètres).
- ORM : requêtes SQL via `pg` + dépôts typés à la main (migrations SQL numérotées) pour garder le contrôle des verrous (`SKIP LOCKED`, advisory locks, triggers).

## Écarts par rapport au plan initial

- **CSS** : CSS simple avec variables (tokens du design system) au lieu de Tailwind. Moins de dépendances, mêmes tokens (`globals.css`).
- **Verrou par tenant** : les handlers de webhook sont sérialisés par un verrou consultatif au niveau du tenant (`lockTenant`), plus simple et plus sûr que le verrou par facture prévu.
- **Jetons de paiement dérivés** : le jeton de la page client est dérivé par HMAC (cas + génération) ; seul son hash sha256 est stocké. Un seul jeton actif par dossier (index unique partiel), expiration à 14 jours, marqué utilisé uniquement après un paiement réussi.
- **Relances natives Stripe** : la désactivation ne peut pas être vérifiée par l'API ; l'étape d'onboarding est une confirmation manuelle du fondateur.
- **Simulation d'échec (S9.6)** : remplacée par l'email de test + le mode « dry run », qui couvrent le besoin sans écrire aux clients.
- **Mode E2E** : `RECOVERKIT_E2E=1` branche des adaptateurs factices (Stripe, email, horloge) pilotables par `/api/e2e/*` (jeton obligatoire) et le champ carte factice (`pk_fake_e2e`, route `fake-complete`). Ces routes répondent 404 hors de ce mode. Le vrai Stripe.js (Elements, 3-D Secure) n'est vérifiable qu'à la main contre un compte de test Stripe.
- **Referrer-Policy** : `same-origin` au lieu de `no-referrer` sur les pages sensibles. Avec `no-referrer`, les navigateurs envoient `Origin: null` sur les POST de formulaire, ce que la protection CSRF refuse (bug trouvé par le test E2E de connexion). Aucun jeton ne fuit vers un autre site dans les deux cas.
- **APP_URL en production** : HTTPS exigé, sauf `localhost` (démarrage local et E2E avec `next start`).
- **Pages légales** : modèles à compléter par l'exploitant (raison sociale, adresse, hébergeur) avant la mise en production ; aucune donnée d'entreprise n'est inventée.
- **Prix** : aucun prix n'est codé en dur ; sans `PLANS`, le site affiche l'essai gratuit seul et la facturation n'est pas appliquée.

## Compromis acceptés

- **Envoi d'email et appels Stripe sous le verrou consultatif du tenant** : `mailer.send` et les appels Stripe sont exécutés alors que le verrou du tenant est tenu. Justification : le verrou garde contre une clôture ou une pause du tenant pendant l'envoi (aucune relance partie après clôture). Les clés d'idempotence protègent des doublons en cas de rejeu. Le blocage est borné par les délais d'attente : Resend 15 s, Stripe 20 s.
- **`payment_attempts` non committé avant l'appel Stripe** : la ligne est écrite dans la transaction en cours, pas avant l'appel. Justification : la clé d'idempotence `retry:<dossier>:<moyen>` garantit un seul débit au rejeu ; si la transaction est annulée, le rejeu avec la même clé renvoie le même résultat Stripe, donc le rollback ne perd aucun débit (le revenu reste auditable).
