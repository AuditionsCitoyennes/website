// The facts the three legal pages state, kept as data so a change of host,
// provider or retention period is one edit here. Keep them true: each row
// describes what the site and its providers do now.

/** The day the pages last changed, as they print it. */
export const UPDATED = "3 novembre 2026";

/** Where the site lives (LCEN art. 1-1 II: a non-professional publisher names
 *  the hosts and their address). */
export const HOSTS = [
  {
    role: "Le site (ses pages et ses fichiers)",
    name: "Cloudflare, Inc.",
    address: "101 Townsend Street, San Francisco, CA 94107, États-Unis",
  },
  {
    role: "Le serveur de l'application et les sauvegardes",
    name: "Scaleway SAS",
    address: "8 rue de la Ville-l'Évêque, 75008 Paris, France",
  },
  {
    role: "La base de données et les comptes (serveurs à Stockholm, Suède)",
    name: "Supabase Pte. Ltd.",
    address: "65 Chulia Street #38-02/03, OCBC Centre, Singapour 049513",
  },
] as const;

/** Who receives personal data, for what, and where it goes. */
export const RECIPIENTS = [
  {
    name: "Supabase",
    purpose: "Base de données et comptes",
    data: "Témoignages, comptes des volontaires",
    where: "Union européenne (Suède)",
  },
  {
    name: "Scaleway",
    purpose: "Serveur de l'application, sauvegardes chiffrées",
    data: "Toutes les données, le temps de les traiter\u00a0; copies chiffrées",
    where: "France",
  },
  {
    name: "Cloudflare",
    purpose: "Diffusion du site et protection contre les abus",
    data: "Adresse IP, pages demandées",
    where: "Réseau mondial (entreprise américaine)",
  },
  {
    name: "Resend",
    purpose: "Envoi des emails (validation, comptes)",
    data: "Adresse email, nom indiqué, lieu de l'audition",
    where: "États-Unis",
  },
  {
    name: "Anthropic",
    purpose: "Classement d'un témoignage par thèmes, à la demande d'un administrateur",
    data: "Le texte du témoignage seul, sans nom ni email",
    where: "États-Unis",
  },
  {
    name: "Mapbox",
    purpose: "La carte",
    data: "Adresse IP, identifiant aléatoire de mesure (voir «\u00a0Traceurs\u00a0»)",
    where: "États-Unis",
  },
  {
    name: "IGN et Base Adresse Nationale (services de l'État)",
    purpose: "Recherche d'une commune ou d'une adresse dans les formulaires",
    data: "Ce que vous tapez, adresse IP",
    where: "France",
  },
  {
    name: "Google",
    purpose: "Connexion «\u00a0avec Google\u00a0», si vous la choisissez",
    data: "Nom et email de votre compte Google",
    where: "États-Unis",
  },
  {
    name: "Unsplash, Pexels",
    purpose: "Photos de la page d'accueil",
    data: "Adresse IP (chargement des images)",
    where: "Leurs serveurs d'images",
  },
] as const;

/** How long each kind of data is kept. The 15 days and 8 days are purged
 *  when the next testimony is sent, and the one-year logs are not trimmed
 *  yet: a scheduled purge job is to make all three hold on their own. */
export const RETENTION = [
  {
    what: "Témoignage envoyé en ligne et pas encore validé",
    how: "Supprimé s'il n'est pas validé dans les 15 jours",
  },
  {
    what: "Empreinte de l'email (pour la limite d'un témoignage par semaine)",
    how: "8 jours\u00a0; l'adresse elle-même n'est pas gardée",
  },
  {
    what: "Témoignage publié",
    how: "Tant qu'il est en ligne\u00a0: vous pouvez le retirer à tout moment",
  },
  {
    what: "Email laissé lors d'une audition publique",
    how: "Tant que le témoignage est en ligne, pour pouvoir vous joindre à son sujet",
  },
  {
    what: "Compte de volontaire",
    how: "Jusqu'à sa suppression, depuis l'espace admin ou sur demande\u00a0; une inscription refusée est supprimée aussitôt",
  },
  {
    what: "Journal d'administration (inscriptions acceptées ou refusées, comptes supprimés, avec l'email) et journal des connexions des volontaires (avec l'adresse IP)",
    how: "1 an",
  },
  {
    what: "Adresse IP des visiteurs",
    how: "Gardée en mémoire seulement, au plus 24 heures, pour limiter les abus",
  },
  {
    what: "Sauvegardes de la base",
    how: "30 jours, chiffrées",
  },
] as const;

/** What the site stores in the browser (CNIL: tell visitors, even of the
 *  exempt ones). */
export const TRACKERS = [
  {
    name: "Session de connexion",
    kind: "Stockage local",
    purpose: "Rester connecté. Volontaires et administrateurs seulement",
    until: "La déconnexion",
  },
  {
    name: "theme",
    kind: "Stockage local",
    purpose: "Retenir le mode clair ou sombre, si vous l'avez changé",
    until: "Jusqu'à ce que vous l'effaciez",
  },
  {
    name: "mapbox.eventData…",
    kind: "Stockage local, posé par Mapbox",
    purpose:
      "Un identifiant aléatoire que Mapbox joint à ses statistiques d'usage, pour compter les chargements de la carte. Ni publicité ni profilage",
    until: "Jusqu'à ce que vous l'effaciez",
  },
  {
    name: "mapbox-tiles",
    kind: "Cache du navigateur, posé par Mapbox",
    purpose: "Garder les morceaux de carte déjà téléchargés",
    until: "Géré par le navigateur",
  },
] as const;
