// The testing options as data, in the order the menu shows them: each row's
// key, name, choices, its sentences for a tester (what changes on screen, when
// to switch) and whether choosing reloads the page. The menu draws them
// (DevOptionsMenu.vue), the test checks them (devOptions.test.ts); the switch
// modules own the keys, the defaults and the reads (dataSource.ts,
// map/plateau/lidSwitch, map/plateau/meshSwitch, map/relief/reliefSwitch,
// analyses/devSwitch, map/plateau/terrainSwitch). Testing tools only:
// imported by DevOptionsMenu.vue alone, so a production build has none of
// these strings. French typography:
// a no-break space ( ) after « and before », ;, :, ? and %.

export type DevSection = "donnees" | "carte" | "analyses";

export type DevKey =
  | "ac:data-source"
  | "ac:place-tree"
  | "ac:lid"
  | "ac:lid-check"
  | "ac:mesh"
  | "ac:relief-prefetch"
  | "ac:frame-fill"
  | "ac:analyses-pending"
  | "ac:slab-lid-verre"
  | "ac:slab-text"
  | "ac:slab-size"
  | "ac:ring-band"
  | "ac:terrain";

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
  /** Shown but disabled while another option holds this value. */
  inactiveWhen?: { key: DevKey; id: string };
}

/** The dialog's description (exported so the test checks it like the sentences). */
export const DEV_DESCRIPTION =
  "Ces options servent aux essais, sur un poste de développement et sur le site de pré-production ; le site public n'en a aucune. Chaque choix reste enregistré dans ce navigateur. ↻ : changer cette option recharge la page.";

export const DEV_SECTIONS: readonly { id: DevSection; title: string; intro: string }[] = [
  {
    id: "donnees",
    title: "Données",
    intro: "D'où viennent les chiffres, et la liste des lieux des Filtres.",
  },
  { id: "carte", title: "Carte", intro: "Le relief du territoire choisi et son cadrage." },
  {
    id: "analyses",
    title: "Analyses",
    intro: "Ce qui s'affiche quand le bouton Analyses est activé.",
  },
];

/** "Taille" and "Cadrage": the stored percentages (analyses/devSwitch: SCALE_CHOICES). */
const SHARES: readonly DevChoice[] = [
  { id: "70", label: "70 %" },
  { id: "80", label: "80 %" },
  { id: "90", label: "90 %" },
  { id: "100", label: "100 %" },
];

export const DEV_OPTIONS: readonly DevOption[] = [
  {
    key: "ac:data-source",
    section: "donnees",
    label: "Données",
    choices: [
      { id: "corpus", label: "Corpus" },
      { id: "serveur", label: "Serveur" },
      { id: "comparer", label: "Comparer" },
    ],
    explain:
      "D'où la page tire ses chiffres et ses listes. « Serveur » (par défaut, comme le site public) les demande au serveur ; « Corpus » télécharge tous les témoignages et compte dans la page ; « Comparer » affiche ceux du serveur, recompte à côté et signale les écarts (pastille Δ).",
    reloads: true,
    defaultId: "serveur",
  },
  {
    key: "ac:place-tree",
    section: "donnees",
    label: "Arbre des lieux",
    choices: [
      { id: "sans", label: "Sans arr." },
      { id: "avec", label: "Avec arr." },
    ],
    explain:
      "Dans le champ « Lieu » des Filtres, Paris, Lyon et Marseille apparaissent chacune comme une seule commune (« Sans arr. », par défaut) ou avec leurs arrondissements en dessous (« Avec arr. »). Sans effet avec « Corpus ».",
    reloads: false,
    defaultId: "sans",
  },
  {
    key: "ac:lid",
    section: "carte",
    label: "Couvercle",
    choices: [
      { id: "ecran", label: "Écran" },
      { id: "ancien", label: "Ancien" },
      { id: "aucun", label: "Aucun" },
    ],
    explain:
      "Le territoire choisi se soulève en relief, et le dessus du relief est une image de la carte. « Écran » (par défaut) règle la finesse de cette image selon votre écran ; « Ancien » reprend l'ancienne règle, qui ne tient pas compte de l'écran ; « Aucun » ne fait pas d'image : la carte est posée directement sur le relief.",
    reloads: true,
    defaultId: "ecran",
  },
  {
    key: "ac:lid-check",
    section: "carte",
    label: "Contrôle",
    choices: [
      { id: "signaux", label: "Signaux" },
      { id: "pixels", label: "Pixels" },
    ],
    explain:
      "Avant de poser l'image sur le dessus du relief, la page vérifie qu'elle est bien dessinée. « Signaux » (par défaut) se fie à ce que la carte annonce, sans regarder l'image (sauf après une erreur de la carte) ; « Pixels », l'ancienne méthode, regarde chaque image et refuse celle qui est toute d'une couleur, même une vraie étendue de mer. Sans effet si Couvercle est « Aucun ».",
    reloads: true,
    defaultId: "signaux",
    inactiveWhen: { key: "ac:lid", id: "aucun" },
  },
  {
    key: "ac:mesh",
    section: "carte",
    label: "Maillage",
    choices: [
      { id: "ancien", label: "Ancien" },
      { id: "concat", label: "Concat" },
      { id: "merc", label: "Merc" },
      { id: "worker", label: "Worker" },
    ],
    explain:
      "Comment la page construit la forme du territoire en relief, ses bords et ses parois. Le dernier choix (par défaut) fait ce calcul en arrière-plan pour que la page reste fluide ; les trois autres le font dans la page, de la plus ancienne à la plus récente méthode.",
    reloads: true,
    defaultId: "worker",
  },
  {
    key: "ac:relief-prefetch",
    section: "carte",
    label: "Préchargement",
    choices: [
      { id: "hillshade", label: "Ombrage" },
      { id: "terrain0", label: "Terrain 0" },
    ],
    explain:
      "Quand on passe d'un territoire à un autre, le relief du nouveau peut se charger d'avance. « Ombrage » (par défaut) le charge pendant que l'ancien redescend ; « Terrain 0 » ne commence à le charger qu'au moment où il prend la place de l'ancien, et le nouveau peut se soulever avant que son relief soit là.",
    reloads: true,
    defaultId: "hillshade",
  },
  {
    key: "ac:frame-fill",
    section: "carte",
    label: "Cadrage",
    choices: SHARES,
    explain:
      "La place que prend un territoire à l'écran quand la carte le cadre (80 % par défaut) : 100 % le fait aller jusqu'aux bords de la partie visible, 70 % laisse plus de carte autour. Avec les analyses ouvertes, la carte se recadre aussitôt ; sinon, au prochain territoire choisi.",
    reloads: false,
    defaultId: "80",
  },
  {
    key: "ac:terrain",
    section: "carte",
    label: "Relief",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "off", label: "À plat" },
    ],
    explain:
      "Certains navigateurs protégés contre le pistage (Safari avec sa protection avancée ou une extension, Brave, Firefox en mode strict) empêchent la carte de dessiner le relief. « Auto » (par défaut) soulève le territoire choisi quand le navigateur le permet, et sinon trace ses contours à plat ; « À plat » montre toujours la carte comme ces navigateurs la voient.",
    reloads: true,
    defaultId: "auto",
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
      "Quand on arrive directement sur un petit territoire sans passer par ceux qui le contiennent (un résultat de la liste filtrée ou d'une recherche, un lieu choisi dans les Filtres), ses chiffres peuvent arriver un peu après lui. En attendant, « Garder » (par défaut) laisse les chiffres d'avant sur les analyses ; « Masquer » n'en montre aucun. Seulement avec « Serveur » ou « Comparer ».",
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
];
