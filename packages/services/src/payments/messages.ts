export type PayLocale = 'fr' | 'en';
export type PayMessageKey =
  | 'form'
  | 'unavailable'
  | 'paid'
  | 'requires_action'
  | 'setup_incomplete'
  | 'error'
  | 'rate_limited'
  | 'dry_run'
  | 'success';

interface Msg {
  title: string;
  body: string;
}

const FR: Record<PayMessageKey, Msg> = {
  form: {
    title: 'Votre paiement n’a pas abouti.',
    body: 'Mettez à jour votre carte pour garder l’accès à votre abonnement. Nous retentons le paiement tout de suite après.',
  },
  unavailable: {
    title: 'Ce lien n’est plus valide.',
    body: 'Il a peut-être expiré. Contactez le support de votre fournisseur pour recevoir un nouveau lien.',
  },
  paid: {
    title: 'Ce paiement est déjà réglé.',
    body: 'Vous n’avez rien d’autre à faire. Votre abonnement continue normalement.',
  },
  requires_action: {
    title: 'Votre banque demande une confirmation.',
    body: 'Confirmez le paiement auprès de votre banque pour terminer la mise à jour de votre carte.',
  },
  setup_incomplete: {
    title: 'Votre carte n’a pas encore été enregistrée.',
    body: 'Vérifiez les informations saisies puis réessayez. Aucun montant n’a été débité.',
  },
  error: {
    title: 'Un problème est survenu de notre côté.',
    body: 'Rien n’a été débité. Patientez un instant puis réessayez, ou contactez le support de votre fournisseur.',
  },
  rate_limited: {
    title: 'Trop de tentatives.',
    body: 'Patientez quelques minutes avant de réessayer.',
  },
  dry_run: {
    title: 'Mode test : aucun paiement n’a été effectué.',
    body: 'Votre carte a bien été enregistrée, mais ce compte est en mode test et ne débite personne.',
  },
  success: {
    title: 'Carte mise à jour.',
    body: 'Nous retentons votre paiement maintenant. Vous recevrez une confirmation dans quelques minutes.',
  },
};

const EN: Record<PayMessageKey, Msg> = {
  form: {
    title: 'Your payment didn’t go through.',
    body: 'Update your card to keep your subscription active. We’ll retry the payment right after.',
  },
  unavailable: {
    title: 'This link is no longer valid.',
    body: 'It may have expired. Contact your provider’s support to get a new link.',
  },
  paid: {
    title: 'This payment is already settled.',
    body: 'There’s nothing else to do. Your subscription continues as usual.',
  },
  requires_action: {
    title: 'Your bank needs a confirmation.',
    body: 'Confirm the payment with your bank to finish updating your card.',
  },
  setup_incomplete: {
    title: 'Your card hasn’t been saved yet.',
    body: 'Check the details you entered and try again. Nothing has been charged.',
  },
  error: {
    title: 'Something went wrong on our side.',
    body: 'Nothing was charged. Wait a moment and try again, or contact your provider’s support.',
  },
  rate_limited: {
    title: 'Too many attempts.',
    body: 'Please wait a few minutes before trying again.',
  },
  dry_run: {
    title: 'Test mode: no payment was made.',
    body: 'Your card was saved, but this account is in test mode and charges no one.',
  },
  success: {
    title: 'Card updated.',
    body: 'We’re retrying your payment now. You’ll receive a confirmation in a few minutes.',
  },
};

export function payMessage(key: PayMessageKey, locale: PayLocale): Msg {
  return (locale === 'fr' ? FR : EN)[key];
}

const CARD_FR: Record<string, string> = {
  insufficient_funds: 'Fonds insuffisants sur cette carte. Utilisez une autre carte ou réessayez après approvisionnement.',
  expired_card: 'Cette carte a expiré. Saisissez une carte dont la date de validité est correcte.',
  incorrect_cvc: 'Le code de sécurité est incorrect. Vérifiez les 3 chiffres au dos de votre carte.',
  processing_error: 'Une erreur est survenue pendant le traitement. Réessayez dans quelques instants.',
  card_declined: 'Votre banque a refusé cette carte. Essayez une autre carte ou contactez votre banque.',
};
const CARD_EN: Record<string, string> = {
  insufficient_funds: 'Insufficient funds on this card. Use another card or try again after topping up.',
  expired_card: 'This card has expired. Enter a card with a valid expiry date.',
  incorrect_cvc: 'The security code is incorrect. Check the 3 digits on the back of your card.',
  processing_error: 'An error occurred while processing. Please try again in a moment.',
  card_declined: 'Your bank declined this card. Try another card or contact your bank.',
};

/** Message d'erreur de carte : dit quoi faire ; un motif inconnu retombe sur le refus générique. */
export function cardErrorMessage(code: string, locale: PayLocale): string {
  const table = locale === 'fr' ? CARD_FR : CARD_EN;
  return table[code] ?? table.card_declined!;
}
