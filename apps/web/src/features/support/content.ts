// The donation link and who receives the money, in one place. The « Soutenir »
// page reads them. The header links to the page only once there is a link to
// give.

/** The outside page where visitors donate. null: not set up yet. Until then
 *  the page says the link is coming and the header leaves it out. */
export const DONATION_URL: string | null = null;

/** The platform the link leads to, named on the button. */
export const DONATION_PLATFORM = "Liberapay";

/** Who receives the donations while the project has no association. */
export const RECIPIENT = "Florent Grea";

/** What the donations pay for (SupportPage). */
export const COSTS = [
  {
    title: "L'hébergement",
    text: "Le site, son serveur et la base de données qui garde les témoignages.",
  },
  {
    title: "La carte",
    text: "Les fonds de carte et les contours des communes, départements et régions.",
  },
  {
    title: "Les emails",
    text: "Les liens envoyés pour relire, modifier, valider ou supprimer son témoignage.",
  },
  {
    title: "Les analyses",
    text: "Les synthèses de ce qui se dit dans chaque territoire.",
  },
];
