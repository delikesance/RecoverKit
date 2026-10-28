const NOTICES: Record<string, string> = {
  saved: 'Modifications enregistrées.',
  paused: 'Dossier mis en pause : plus aucun email ne partira tant que vous ne reprenez pas.',
  resumed: 'Relances reprises.',
  queued: 'Le prochain email part dans la minute.',
  closed: 'Dossier clôturé.',
  done: 'C’est fait.',
  invalid_state: 'Cette action n’est plus possible pour ce dossier.',
  not_found: 'Dossier introuvable.',
  already_due: 'Le prochain email est déjà prêt à partir.',
  too_soon: 'Un email vient de partir : patientez une heure avant d’en forcer un autre.',
  in_progress: 'Un envoi est déjà en cours.',
  no_step: 'Il ne reste aucune relance à envoyer pour ce dossier.',
  not_active: 'Reprenez d’abord les relances de ce dossier.',
  reason_required: 'Indiquez un motif de clôture (3 caractères au moins).',
  test_sent: 'Email de test envoyé à votre adresse.',
  test_limited: 'Trop d’emails de test : réessayez dans une heure.',
  reset: 'Modèle par défaut restauré.',
  activated: 'Relances activées. Les prochains échecs de paiement seront relancés automatiquement.',
  dry_run: 'Mode test activé : rien n’est envoyé à vos clients.',
  sender_pending: 'Domaine créé. Ajoutez les enregistrements DNS ci-dessous, puis vérifiez.',
  sender_verified: 'Domaine vérifié : vos emails partent maintenant de votre adresse.',
  sender_failed: 'La vérification a échoué : contrôlez les enregistrements DNS.',
  sender_freemail: 'Utilisez une adresse de votre propre domaine (pas gmail.com, outlook.com…).',
  sender_invalid: 'Cette adresse email n’est pas valide.',
  sender_none: 'Aucun domaine à vérifier.',
  sender_removed: 'Expéditeur personnalisé supprimé : l’expéditeur par défaut est utilisé.',
  stripe_disconnected: 'Stripe a été déconnecté : les relances sont arrêtées.',
};

export function Flash({ notice, error }: { notice?: string; error?: string }) {
  const message = notice ? NOTICES[notice] : undefined;
  const err = error ? error.slice(0, 300) : undefined;
  if (!message && !err) return null;
  return err ? (
    <div className="banner banner-critical" role="alert"><span className="grow">{err}</span></div>
  ) : (
    <div className="banner banner-info" role="status"><span className="grow">{message}</span></div>
  );
}
