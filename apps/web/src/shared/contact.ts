// Who answers for the site, and where to write: the legal pages, the footer,
// the forms' notices and the « Signaler » links all read them here.

/** The publisher and publication director (LCEN art. 1-1), until the
 *  association exists. */
export const PUBLISHER = "Florent Grea";

/** General contact: questions, reports, right of reply. */
export const CONTACT_EMAIL = "contact@auditionscitoyennes.com";

/** Personal data: access, correction, removal of a testimony. */
export const PRIVACY_EMAIL = "privacy@auditionscitoyennes.com";

/** The site's source code (AGPL-3.0). */
export const SOURCE_URL = "https://github.com/AuditionsCitoyennes/website";

/** A `mailto:` link with its subject and body filled in. */
export function mailto(to: string, subject: string, body = ""): string {
  const params = [`subject=${encodeURIComponent(subject)}`];
  if (body) params.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${to}?${params.join("&")}`;
}

/** « Signaler » under a testimony: an email to the contact address naming the
 *  testimony and the page it was seen on, with room for the reason. */
export function reportHref(testimony: { id: string; person_name: string }, page: string): string {
  return mailto(
    CONTACT_EMAIL,
    "Signalement d'un témoignage",
    [
      `Témoignage : ${testimony.person_name} (n° ${testimony.id})`,
      `Page : ${page}`,
      "",
      "Pourquoi le signalez-vous ? (propos illicites, informations sur une autre personne, autre)",
      "",
    ].join("\n"),
  );
}
