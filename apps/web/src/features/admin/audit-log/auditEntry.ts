import type { AuditAction, AuditLogRow } from "@ac/shared";
import { formatDateShort } from "@/shared/format/dates";

// One entry of the audit log, read for the table: what was done, by whom, the
// details line, and the audition it is about. Pure functions of the row.

// Keyed by AuditAction, so an action added to the shared list without a label
// here fails the typecheck.
const ACTION_LABELS: Record<AuditAction, string> = {
  registration_approved: "Inscription acceptée",
  registration_declined: "Inscription refusée",
  role_deleted: "Rôle supprimé",
  account_deleted: "Compte supprimé",
  audition_created: "Audition créée",
  audition_updated: "Audition modifiée",
  audition_deleted: "Audition supprimée",
  testimony_created: "Témoignage ajouté",
  testimony_updated: "Témoignage modifié",
  testimony_deleted: "Témoignage supprimé",
  testimony_verified: "Témoignage confirmé",
  testimony_rejected: "Témoignage refusé",
  testimony_submitted: "Témoignage déposé en ligne",
};

// What the witness does through the emailed link: nobody is signed in.
const WITNESS_ACTIONS: readonly string[] = ["testimony_verified", "testimony_rejected"];

const FIELD_LABELS: Record<string, string> = {
  title: "titre",
  date: "date",
  location: "lieu",
  content: "texte",
  status: "statut",
  person_name: "nom",
  person_info: "informations",
  email: "email",
  topics: "thèmes",
};

/** When it was done, as the table shows it. */
export function formatDate(value: string): string {
  return new Date(value).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function actionLabel(action: string): string {
  return Object.hasOwn(ACTION_LABELS, action) ? ACTION_LABELS[action as AuditAction] : action;
}

/** Who did it. Without an account behind the entry it is the witness (their
 *  verification link) or, for everything else, an account deleted since: the
 *  entry outlives its author, whose id is then cleared. */
export function actorLabel(entry: AuditLogRow): string {
  if (entry.user_email) return entry.user_email;
  if (WITNESS_ACTIONS.includes(entry.action)) return "Témoin (lien de vérification)";
  // The audition a witness's withdrawal left empty, deleted with it.
  if ((entry.metadata as Record<string, unknown> | null)?.by_witness === true) {
    return "Témoin (lien de vérification)";
  }
  if (entry.action === "testimony_submitted") return "Visiteur (formulaire Témoigner)";
  // Deleting one's own account: the author is the account named in the entry.
  const own = (entry.metadata as Record<string, unknown> | null)?.target_email;
  if (entry.action === "account_deleted" && typeof own === "string") return own;
  return "Compte supprimé depuis";
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** One readable line from an entry's metadata. Every field is optional: older
 *  entries and best-effort lookups leave gaps, and a gap is just left out. */
export function formatDetails(entry: AuditLogRow): string {
  const meta = (entry.metadata ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof meta[key] === "string" ? (meta[key] as string) : "");
  const count = (key: string) => (typeof meta[key] === "number" ? (meta[key] as number) : null);
  const fields = Array.isArray(meta.fields)
    ? meta.fields
        .filter((f): f is string => typeof f === "string")
        .map((f) => (Object.hasOwn(FIELD_LABELS, f) ? FIELD_LABELS[f] : f))
        .join(", ")
    : "";
  // Anything but a plain date is shown as it is: the formatter throws on a
  // date it cannot parse, and one bad row must not take the table down.
  const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDateShort(v) : v);
  const parts: string[] = [];

  switch (entry.action as AuditAction) {
    case "audition_created":
    case "audition_updated":
    case "audition_deleted": {
      const n = count("testimonies");
      if (text("title")) parts.push(`« ${text("title")} »`);
      if (entry.action !== "audition_updated") {
        const where = [text("date") && day(text("date")), text("location")];
        if (where.some(Boolean)) parts.push(where.filter(Boolean).join(", "));
      }
      if (fields) parts.push(`modifié : ${fields}`);
      if (text("status")) parts.push(text("status") === "published" ? "publiée" : "en brouillon");
      if (meta.emptied === true) parts.push("supprimée avec son dernier témoignage");
      if (n) {
        parts.push(
          entry.action === "audition_deleted"
            ? plural(n, "témoignage supprimé", "témoignages supprimés")
            : plural(n, "témoignage", "témoignages"),
        );
      }
      break;
    }
    case "testimony_created":
    case "testimony_updated":
    case "testimony_deleted":
    case "testimony_verified":
    case "testimony_rejected":
    case "testimony_submitted": {
      const n = count("testimonies");
      const again = entry.action === "testimony_updated" ? "nouvelle " : "";
      if (text("audition_title")) parts.push(`Audition « ${text("audition_title")} »`);
      if (n) parts.push(plural(n, "témoignage supprimé", "témoignages supprimés"));
      if (fields) parts.push(`modifié : ${fields}`);
      if (text("verification") === "sent") parts.push(`${again}vérification demandée par email`);
      if (text("verification") === "failed") parts.push("email de vérification non envoyé");
      if (text("verification") === "none") parts.push("sans vérification");
      if (meta.edited === true) parts.push("avec corrections du témoin");
      if (entry.action === "testimony_rejected") parts.push("témoignage retiré");
      if (entry.action === "testimony_submitted") {
        if (text("town_hall")) parts.push(text("town_hall") as string);
        if (meta.audition_created === true) parts.push("audition en ligne créée");
        parts.push("en attente de validation par email");
      }
      break;
    }
    default: {
      // Accounts and roles.
      const who = [text("target_email"), text("target_username") && `(${text("target_username")})`];
      if (who.some(Boolean)) parts.push(who.filter(Boolean).join(" "));
      if (text("role")) parts.push(`rôle ${text("role")}`);
    }
  }
  return parts.join(" · ");
}

/** The audition behind an entry, when there is one left to look at: the
 *  audition itself, or the one a testimony belongs to. */
export function auditionIdOf(entry: AuditLogRow): string | null {
  if (entry.action === "audition_deleted") return null;
  if (entry.target_type === "audition" && entry.target_id) return entry.target_id;
  const id = (entry.metadata as Record<string, unknown> | null)?.audition_id;
  return typeof id === "string" && id ? id : null;
}
