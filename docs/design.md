# RecoverKit — Conception MVP (v0.1, à valider)

Statut : proposition. Stack et implémentation volontairement exclues.

## 1. Personas

**Léa, fondatrice solo (utilisatrice)**
- SaaS B2C/B2B en abonnement Stripe, 50–2 000 abonnés, MRR 2–50 k€.
- Perd 5–10 % de MRR en churn involontaire, sans temps pour des relances manuelles.
- Attend : connecter Stripe en < 10 min, zéro maintenance, un chiffre clair « récupéré ce mois-ci ».
- Ne veut pas : un CRM, du paramétrage de campagne, un outil à surveiller.

**Marc, client final (payeur du SaaS de Léa)**
- Ne connaît pas RecoverKit. Reçoit un email au nom de Léa.
- Attend : comprendre en 5 s, mettre à jour sa carte en 2 clics, sans créer de compte.
- N'a **jamais** accès au dashboard.

## 2. Parcours

**Fondateur**
1. Inscription → connexion Stripe (OAuth) → vérification du domaine/expéditeur email → relecture de la séquence par défaut → activation (avec mode « test / dry-run » proposé).
2. Quotidien : ouvre rarement ; reçoit un récap hebdo (revenu récupéré, échecs en cours).
3. Ponctuel : modifie un template, met en pause un cas, relance manuellement, consulte le journal.

**Client final**
1. Paiement échoue → email #1 → clique → page sécurisée → saisit une nouvelle carte (SetupIntent) → confirmation → paiement relancé automatiquement → email de confirmation.
2. S'il ignore : emails suivants selon la séquence ; si paiement réussi par un autre moyen, la séquence s'arrête.

## 3. Flow applicatif de bout en bout

```
Stripe ──webhook──▶ [Réception] vérif. signature → inbox(event_id UNIQUE) → 200 immédiat
                         │
                         ▼
                  [Traitement async]
   invoice.payment_failed ─▶ ouvre/MAJ RecoveryCase ─▶ planifie les étapes (ScheduledStep)
   invoice.paid           ─▶ clôture case (RECOVERED) + écriture ledger
   subscription.deleted   ─▶ clôture case (CANCELED)
                         │
                         ▼
                  [Planificateur] étape due ? ─▶ re-vérifie l'état Stripe (facture encore impayée ?)
                         │ oui
                         ▼
                  outbox → envoi email (clé d'idempotence = case_id + step_index)
                         │
                         ▼
   Client clique lien signé ─▶ page update paiement ─▶ SetupIntent ─▶ set default PM
                         │
                         ▼
                  Retry paiement : invoice.pay() ─▶ invoice.paid (webhook) ─▶ RECOVERED
```

Règles transverses
- **Jamais deux relances pour le même événement** : contrainte unique `(case_id, step_index)` + outbox transactionnelle ; le worker « réserve » l'étape (`SCHEDULED → SENDING`) de façon atomique avant tout envoi.
- **Re-vérification avant envoi** : on relit la facture chez Stripe juste avant d'envoyer (évite d'écrire à un client qui vient de payer).
- **Journalisation** : chaque action (email planifié/envoyé/sauté, clic, retry, changement d'état) crée une ligne append-only dans `ActionLog`.
- **Actions sensibles explicites** : envoi d'email, retry de paiement, modification d'abonnement — chacune a un flag par tenant et un mode `dry_run` qui journalise sans exécuter.

## 4. Écrans

### Fondateur
| # | Écran | Contenu clé |
|---|---|---|
| F1 | Onboarding | Connexion Stripe, expéditeur/domaine, séquence par défaut, activation, dry-run |
| F2 | Dashboard | KPI : revenu récupéré (période), clients sauvés, taux de récupération, MRR à risque (échecs en cours) ; courbe récupéré/perdu ; liste des 5 derniers cas |
| F3 | Échecs en cours | Table : client, montant, étape courante, prochaine relance, jours depuis échec ; filtres ; actions : pause, relance manuelle, clôturer |
| F4 | Détail d'un cas | Timeline complète (ActionLog), facture Stripe, liens, état, attribution du revenu |
| F5 | Séquence | Étapes (délai, template, actif/inactif), conditions d'arrêt, fenêtre d'envoi ; aperçu |
| F6 | Templates email | Éditeur sobre : objet, corps, variables (`{{customer_name}}`, `{{amount}}`, `{{plan}}`, `{{update_link}}`), logo/couleur, expéditeur ; envoi de test |
| F7 | Récupérés | Liste des paiements récupérés avec règle d'attribution appliquée (export CSV) |
| F8 | Réglages | Connexion Stripe, emails on/off global, domaine, langue, compte, facturation RecoverKit |

### Client final (aucun compte)
| # | Écran | Contenu clé |
|---|---|---|
| C1 | Mise à jour du paiement | Marque du fondateur, montant dû, plan, formulaire carte (Stripe Elements), mention de sécurité |
| C2 | Succès | Confirmation, paiement en cours/réussi |
| C3 | Échec carte | Message clair, nouvel essai |
| C4 | Lien expiré / invalide / déjà payé | Message neutre + contact du fondateur, pas de fuite d'info |

## 5. États métier

**RecoveryCase** (1 par facture impayée)
```
OPEN ──(1ère étape planifiée)──▶ RECOVERING
RECOVERING ──invoice.paid──────▶ RECOVERED   (terminal)
RECOVERING ──subscription.deleted / facture void / uncollectible──▶ CANCELED (terminal)
RECOVERING ──dernière étape passée + délai de grâce──▶ LOST (terminal)
RECOVERING ◀──▶ PAUSED   (action fondateur ; aucune relance tant que PAUSED)
```
Un `invoice.payment_failed` supplémentaire sur la même facture met à jour `attempt_count`, ne crée pas de nouveau case (clé unique `tenant + invoice_id`).

**ScheduledStep** : `SCHEDULED → SENDING → SENT` ; sorties : `SKIPPED` (case clos / paused / emails désactivés / facture déjà payée), `FAILED` (erreur d'envoi, retry borné, puis alerte).

**PaymentUpdateToken** : `ACTIVE → USED | EXPIRED | REVOKED`.

**Connexion Stripe** : `PENDING → ACTIVE → REVOKED` (via `account.application.deauthorized`).

## 6. Événements Stripe

Hypothèse : **Stripe Connect (OAuth, comptes Standard)** — pas de clé secrète du client stockée ; webhooks Connect reçus avec `event.account`.

| Événement | Action |
|---|---|
| `invoice.payment_failed` | Ouvre/MAJ le case, planifie la séquence (ignore si `billing_reason` hors abonnement ou facture ponctuelle selon réglage) |
| `invoice.paid` / `invoice.payment_succeeded` | Clôture RECOVERED si case ouvert ; écrit le ledger ; annule les étapes restantes |
| `invoice.voided`, `invoice.marked_uncollectible` | CANCELED |
| `customer.subscription.deleted` | CANCELED |
| `customer.subscription.updated` | Rafraîchit statut (`past_due`, `canceled`, `unpaid`) |
| `setup_intent.succeeded` | Confirme le nouveau moyen de paiement → déclenche le retry |
| `payment_method.attached` / `customer.updated` | Si le client change sa carte hors lien → retry anticipé |
| `account.application.deauthorized` | Connexion REVOKED, stoppe tout |

Principes : vérification de signature, déduplication par `event.id`, réponse 200 rapide, traitement asynchrone, tolérance au désordre des événements (on se fie à l'état Stripe relu, pas à l'ordre d'arrivée), rejeu manuel possible.

Interaction avec Stripe Smart Retries : coexistent ; le fondateur doit désactiver les emails de relance natifs Stripe (checklist d'onboarding). Un paiement réussi via Smart Retry clôture le case (voir attribution ci-dessous).

## 7. Revenu récupéré — calcul explicite et auditable

Table `RecoveryLedger` **append-only** : une ligne par facture récupérée.
`tenant_id, case_id, invoice_id, amount_recovered (minor units), currency, paid_at, attribution, rule_version, stripe_event_id`

- `amount_recovered` = `invoice.amount_paid` (Stripe), jamais recalculé.
- **Attribution** (valeur stockée, règle versionnée) :
  - `ASSISTED` : paiement survenu **après l'envoi d'au moins un email** RecoverKit pour ce case (ou via un lien RecoverKit).
  - `NATURAL` : payé avant tout email (Smart Retry, client proactif).
- Dashboard : **« Récupéré »** = ASSISTED (chiffre vendu, prudent) ; **« Total payé après échec »** affiché à part. Pas de gonflement du ROI.
- Remboursement/dispute postérieurs : ligne d'ajustement négative, jamais de modification d'une ligne existante.
- Devise : montants stockés et agrégés **par devise** (pas de conversion, multi-devises avancé hors périmètre).

## 8. Séquence par défaut (configurable)

| Étape | Délai après échec | Contenu |
|---|---|---|
| 1 | +1 h | « Votre paiement a échoué » + lien |
| 2 | +3 jours | Rappel, ton neutre |
| 3 | +7 jours | Avertissement : accès bientôt suspendu |
| 4 | +12 jours | Dernier avis |
Retry automatique du paiement : à chaque mise à jour de carte, et la veille de l'étape 4. Emails envoyés dans une fenêtre horaire locale (par défaut 9h–19h). Arrêt immédiat si case clos.

## 9. Sécurité de la page de mise à jour

- Token aléatoire ≥ 128 bits, **stocké haché**, lié à `case_id`, expiration (14 j), révoqué à la clôture ; pas d'info personnelle dans l'URL.
- Carte saisie uniquement via Stripe Elements (aucune donnée carte chez nous, périmètre PCI minimal).
- Rate limiting par IP/token, CSRF, `Referrer-Policy: no-referrer`, `noindex`, messages d'erreur génériques.
- Isolation stricte par tenant (toute requête filtrée par `tenant_id`) ; le token ne donne accès qu'à C1–C4.
- Domaine d'envoi authentifié (SPF/DKIM/DMARC) par tenant ; lien de désactivation/contact présent.

## 10. Métriques produit

Dashboard fondateur
- Revenu récupéré (ASSISTED), par période, par devise
- Clients sauvés (cases RECOVERED)
- Taux de récupération = récupérés / cases clos (+ version en montant)
- MRR à risque = somme des cases RECOVERING
- Délai médian de récupération ; récupération par étape de séquence
- Taux d'ouverture/clic (indicatif)

Produit interne (nord : le ROI du client)
- Time-to-first-recovery, activation (Stripe connecté + séquence active sous 24 h)
- Rapport revenu récupéré / abonnement RecoverKit (ROI client)
- Fiabilité : webhooks traités < 1 min, taux d'échec d'envoi, doublons de relance (**doit être 0**)

## 11. Modèle de données (esquisse)

`Tenant, StripeConnection, InboxEvent(event_id unique), RecoveryCase(tenant+invoice unique), Sequence, SequenceStep, ScheduledStep(case+index unique), EmailTemplate, PaymentUpdateToken, ActionLog(append-only), RecoveryLedger(append-only), EndCustomer(snapshot minimal: email, nom)`

## 12. Tranches verticales proposées

1. **Tranche 1 — Colonne vertébrale** : webhook sécurisé → case → 1 email → page de mise à jour → retry → `invoice.paid` → ledger (en dry-run puis réel sur compte Stripe test).
2. **Tranche 2** : séquence multi-étapes configurable + journal + pause/relance manuelle.
3. **Tranche 3** : dashboard (KPI + liste des échecs + détail).
4. **Tranche 4** : onboarding (Connect OAuth, domaine email, checklist) + templates personnalisables.
5. **Tranche 5** : récap hebdo, export CSV, durcissement.

## 13. Décisions à valider

1. Stripe Connect OAuth (recommandé) vs clé restreinte collée par le client ?
2. Attribution « Récupéré » = ASSISTED uniquement, avec « Total payé après échec » affiché à part : OK ?
3. Séquence par défaut (1h / 3j / 7j / 12j) et fenêtre d'envoi 9h–19h : OK ?
4. Factures concernées : abonnements uniquement, ou aussi factures ponctuelles ?
5. Langues des emails au MVP : FR seul, ou FR + EN ?
6. Modèle de prix RecoverKit (abonnement fixe vs % du récupéré) — impacte le ledger et la facturation, pas l'architecture.
