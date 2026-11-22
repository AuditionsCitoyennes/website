// The testing options as data, in the order the menu shows them: each row's
// key, name, choices, its sentences for a tester (what changes on screen, when
// to switch) and whether choosing reloads the page. The menu draws them
// (DevOptionsMenu.vue), the test checks them (devOptions.test.ts); the switch
// modules own the keys, the defaults and the reads (map/fallbackSwitch,
// geo-nav/panel/sheetFitSwitch, analyses/devSwitch, shared/device/deviceTier,
// map/graphicsSwitch). Under the
// « Appareil » row the dialog lists what the page knows of the device
// (`tierFacts`). Testing tools only: imported by DevOptionsMenu.vue alone, so
// a production build has none of these strings. French typography: a no-break
// space ( ) after « and before », ;, :, ? and %.

import type {
  DeviceSignals,
  MeasureRecord,
  DeviceTier,
  TierReason,
  TierVerdict,
} from "@/shared/device/deviceTier";

export type DevSection = "carte" | "panneau" | "analyses" | "appareil";

export type DevKey =
  | "ac:analyses-pending"
  | "ac:slab-lid-verre"
  | "ac:slab-text"
  | "ac:slab-size"
  | "ac:ring-band"
  | "ac:tier"
  | "ac:map-fallback"
  | "ac:sheet-fit"
  | "ac:dpr"
  | "ac:frame-measure";

export interface DevChoice {
  /** The value the switch stores. */
  id: string;
  label: string;
}

export interface DevOption {
  key: DevKey;
  section: DevSection;
  label: string;
  choices: readonly DevChoice[];
  /** One or two plain French sentences: what changes on screen, when to switch. */
  explain: string;
  /** The setter reloads the page (the switch is read once per load). */
  reloads: boolean;
  /** The switch's default (the test ties it to the module's and to the sentence's « (par défaut) »). */
  defaultId: string;
}

/** The dialog's description (exported so the test checks it like the sentences). */
export const DEV_DESCRIPTION =
  "Ces options servent aux essais, sur un poste de développement et sur le site de pré-production ; le site public n'en a aucune. Chaque choix reste enregistré dans ce navigateur. ↻ : changer cette option recharge la page.";

/** The mark of a row whose choice is not the default, and of the dialog's top line. */
export const DEV_CHANGED_MARK = "modifié";
export const DEV_NONE_CHANGED = "Aucun choix modifié.";
export const DEV_RESET_LABEL = "Tout remettre par défaut";
/** "1 choix modifié", "3 choix modifiés": the top line's and the DEV button's count. */
export const changedCount = (n: number) => `${n} choix ${DEV_CHANGED_MARK}${n > 1 ? "s" : ""}`;

export const DEV_SECTIONS: readonly { id: DevSection; title: string; intro: string }[] = [
  {
    id: "carte",
    title: "Carte",
    intro: "Ce que montre son cadre quand elle ne démarre pas.",
  },
  {
    id: "panneau",
    title: "Panneau",
    intro: "Ce que fait le panneau des témoignages sur un téléphone.",
  },
  {
    id: "analyses",
    title: "Analyses",
    intro: "Ce qui s'affiche quand le bouton Analyses est activé.",
  },
  {
    id: "appareil",
    title: "Appareil",
    intro: "Ce que la page sait de la puissance de cet appareil.",
  },
];

/** "Taille": the stored percentages (analyses/devSwitch: SCALE_CHOICES). */
const SHARES: readonly DevChoice[] = [
  { id: "70", label: "70 %" },
  { id: "80", label: "80 %" },
  { id: "90", label: "90 %" },
  { id: "100", label: "100 %" },
];

export const DEV_OPTIONS: readonly DevOption[] = [
  {
    key: "ac:map-fallback",
    section: "carte",
    label: "Carte indisponible",
    choices: [
      { id: "visiteur", label: "Visiteur" },
      { id: "essai", label: "Essai" },
    ],
    explain:
      "Quand la carte ne peut pas démarrer (navigateur sans affichage 3D, clé de la carte refusée), son cadre montre la France en image, en retrait, sous une phrase simple. « Visiteur » (par défaut) démarre la carte comme d'habitude ; « Essai » ne la démarre pas du tout, pour voir ce cadre sur n'importe quel appareil. Le même cadre, avec un bouton « Réessayer », sert quand le fond de carte n'arrive pas malgré les nouveaux essais.",
    reloads: true,
    defaultId: "visiteur",
  },
  {
    key: "ac:sheet-fit",
    section: "panneau",
    label: "Hauteur",
    choices: [
      { id: "ajuste", label: "Ajusté" },
      { id: "centre", label: "Ajusté, centré" },
      { id: "plein", label: "Plein" },
    ],
    explain:
      "Sur un téléphone, la hauteur du panneau des témoignages quand il est remonté. « Ajusté » (par défaut) le fait aussi haut que ce qu'il montre : deux villes, et la carte reste visible au-dessus ; une longue liste, et il monte jusqu'en haut ; un lieu ouvert reste en haut de la carte. « Ajusté, centré » fait de même mais place le lieu ouvert au milieu de la carte visible au-dessus du panneau : la carte suit alors sa hauteur. « Plein » le monte toujours jusqu'en haut, comme avant. Rien ne change sur un ordinateur.",
    reloads: false,
    defaultId: "ajuste",
  },
  {
    key: "ac:analyses-pending",
    section: "analyses",
    label: "Analyses en attente",
    choices: [
      { id: "garder", label: "Garder" },
      { id: "masquer", label: "Masquer" },
    ],
    explain:
      "Quand on arrive directement sur un petit territoire sans passer par ceux qui le contiennent (un résultat de la liste filtrée ou d'une recherche, un lieu choisi dans les Filtres), ses chiffres peuvent arriver un peu après lui. En attendant, « Garder » (par défaut) laisse les chiffres d'avant sur les analyses ; « Masquer » n'en montre aucun.",
    reloads: false,
    defaultId: "garder",
  },
  {
    key: "ac:slab-lid-verre",
    section: "analyses",
    label: "Dalle",
    choices: [
      { id: "verre", label: "Verre" },
      { id: "opaque", label: "Opaque" },
      { id: "carte", label: "Carte" },
    ],
    explain:
      "Le fond des étiquettes des analyses posées sur la carte (le nom du thème, la plaque des chiffres). « Verre » (par défaut) laisse voir la carte floutée derrière ; « Opaque » la cache tout à fait ; « Carte » la laisse voir nette, les mots cernés pour rester lisibles.",
    reloads: false,
    defaultId: "verre",
  },
  {
    key: "ac:slab-text",
    section: "analyses",
    label: "Texte",
    choices: [
      { id: "redresse", label: "Redressé" },
      { id: "plat", label: "À plat" },
    ],
    explain:
      "La carte est vue penchée. « Redressé » (par défaut) étire les étiquettes, comme les inscriptions peintes sur une route, pour que les mots gardent leurs vraies proportions ; « À plat » les pose telles quelles, et les mots paraissent écrasés.",
    reloads: false,
    defaultId: "redresse",
  },
  {
    key: "ac:slab-size",
    section: "analyses",
    label: "Taille",
    choices: SHARES,
    explain:
      "La taille des mots des analyses quand la carte vient de se cadrer sur un territoire, par rapport au texte normal du site (80 % par défaut). Plus grand se lit mieux mais prend plus de place : la carte se recadre aussitôt.",
    reloads: false,
    defaultId: "80",
  },
  {
    key: "ac:ring-band",
    section: "analyses",
    label: "Anneau",
    choices: [
      { id: "fin", label: "Fin" },
      { id: "moyen", label: "Moyen" },
      { id: "epais", label: "Épais" },
    ],
    explain:
      "L'épaisseur du cercle des thèmes : « Moyen » (par défaut) est la bande actuelle ; « Fin », l'ancienne, plus mince, au trou plus grand ; « Épais », une bande plus large. La taille du cercle ne change pas.",
    reloads: false,
    defaultId: "moyen",
  },
  {
    key: "ac:tier",
    section: "appareil",
    label: "Niveau",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "full", label: "Complet" },
      { id: "light", label: "Léger" },
      { id: "minimal", label: "Minimal" },
    ],
    explain:
      "Le niveau de puissance retenu pour cet appareil. « Auto » (par défaut) le déduit des signaux listés ci-dessous : peu de mémoire, peu de cœurs, l'économie de données ou une connexion lente donnent « Léger » ; un affichage calculé sans puce graphique donne « Minimal » ; des images trop lentes pendant un déplacement de la carte font descendre d'un niveau ou de deux. Les trois autres choix imposent un niveau. En dépendent, entre autres : la police des noms de la carte, le sol sous le territoire choisi, le verre des panneaux, le lissage des bords, la mémoire gardée par la carte, le mouvement, l'ouverture de la carte de l'accueil et la carte de l'accueil elle-même (une image sur un appareil faible).",
    reloads: true,
    defaultId: "auto",
  },
  {
    key: "ac:dpr",
    section: "appareil",
    label: "Finesse",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "1.5", label: "1,5" },
    ],
    explain:
      "Le nombre de points que la carte dessine pour chaque point de la page. « Auto » (par défaut) suit la finesse de l'écran ; « 1,5 » s'arrête à une fois et demie : sur un écran très fin, la carte et ses textes sont un peu plus flous et demandent moins de calcul, le reste de la page ne change pas. Pour l'instant « Auto » ne réduit jamais, même quand l'affichage est lent : la carte n'a pas de réglage prévu pour cela, ce choix sert à juger l'effet à l'œil.",
    reloads: true,
    defaultId: "auto",
  },
  {
    key: "ac:frame-measure",
    section: "appareil",
    label: "Mesure",
    choices: [
      { id: "on", label: "Activée" },
      { id: "off", label: "Coupée" },
    ],
    explain:
      "Au premier déplacement animé de la carte vers un territoire, la page chronomètre les images. « Activée » (par défaut) : si elles sont trop lentes, le niveau de l'appareil descend pour ce chargement de page seulement, et le navigateur le note. Le niveau plus bas n'est gardé trente jours que si un autre chargement de page, commencé au moins une minute plus tard, mesure encore des images lentes ; une mesure correcte entre les deux efface la note (ligne « Images mesurées » ci-dessous). « Coupée » : rien n'est chronométré, comme avant.",
    reloads: true,
    defaultId: "on",
  },
];

/** The rows whose choice now (`read`: a key's value, as its switch stores it)
 *  is not the default, in the menu's order. */
export function changedOptions(read: (key: DevKey) => string): DevOption[] {
  return DEV_OPTIONS.filter((o) => read(o.key) !== o.defaultId);
}

/** Every row back to its default: its stored key removed (`remove`:
 *  localStorage's). The caller loads the page again, once. */
export function clearOptions(remove: (key: DevKey) => void) {
  for (const o of DEV_OPTIONS) remove(o.key);
}

/** A line of the « Appareil » section: something the page knows of the device. */
export interface DevFact {
  label: string;
  value: string;
}

const TIER_LABELS: Record<DeviceTier, string> = {
  full: "Complet",
  light: "Léger",
  minimal: "Minimal",
};
const REASON_LABELS: Record<TierReason, string> = {
  forced: "imposé",
  memory: "peu de mémoire",
  cores: "peu de cœurs",
  "save-data": "économie de données",
  link: "connexion lente",
  renderer: "affichage sans puce graphique",
  frames: "images lentes mesurées",
};
const KIND_LABELS = { cpu: "processeur", gpu: "affichage", unknown: "cause non mesurée" } as const;
const yesNo = (v: boolean) => (v ? "oui" : "non");

/** What the page knows of the device, for the dialog: the tier detected
 *  (`detected`: the signals read with « Auto ») and why, the tier in force
 *  when the switch forces another, the two kinds of weak, then each signal. */
export function tierFacts(
  signals: DeviceSignals,
  detected: TierVerdict,
  inForce: TierVerdict,
  kept?: MeasureRecord,
): DevFact[] {
  const why = detected.reasons.map((r) => REASON_LABELS[r]).join(", ");
  const m = signals.measured;
  const day = (at: number) => new Date(at).toLocaleDateString("fr-FR");
  // What the measure's two strikes have come to (deviceTier's strikeRule):
  // a step kept, a step for this page load only, or a note waiting.
  const strike = !kept
    ? ""
    : m && kept.step
      ? ", gardé trente jours"
      : m
        ? ", pour ce chargement de page seulement"
        : kept.note
          ? ` ; des images lentes notées le ${day(kept.note.at)}, à confirmer`
          : "";
  return [
    {
      label: "Niveau détecté",
      value: TIER_LABELS[detected.tier] + (why ? ` (${why})` : ""),
    },
    ...(inForce.reasons.includes("forced")
      ? [{ label: "Niveau imposé", value: TIER_LABELS[inForce.tier] }]
      : []),
    { label: "Processeur lent", value: yesNo(inForce.cpuWeak) },
    { label: "Affichage lent", value: yesNo(inForce.gpuWeak) },
    {
      label: "Mémoire",
      value: signals.deviceMemory === null ? "non indiquée" : `${signals.deviceMemory} Go`,
    },
    {
      label: "Cœurs",
      value:
        signals.hardwareConcurrency === null ? "non indiqué" : String(signals.hardwareConcurrency),
    },
    { label: "Économie de données", value: yesNo(signals.saveData) },
    { label: "Connexion", value: signals.effectiveType ?? "non indiquée" },
    { label: "Puce graphique", value: signals.renderer ?? "non lue" },
    {
      label: "Images mesurées",
      value:
        (m
          ? `${TIER_LABELS[m.tier]} (${KIND_LABELS[m.kind]}), le ${day(m.at)}`
          : "aucune descente") + strike,
    },
  ];
}
