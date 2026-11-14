// The testing options as data, in the order the menu shows them: each row's
// key, name, choices, its sentences for a tester (what changes on screen, when
// to switch) and whether choosing reloads the page. The menu draws them
// (DevOptionsMenu.vue), the test checks them (devOptions.test.ts); the switch
// modules own the keys, the defaults and the reads (dataSource.ts,
// map/plateau/lidSwitch, map/plateau/meshSwitch, map/relief/reliefSwitch,
// geo-nav/bootListSwitch, map/bootWorkersSwitch, geo-nav/data/outlinesDecorSwitch,
// map/glyphSwitch, shared/device/glassSwitch, shared/boot/mapPreload,
// shared/api/authClientSwitch, map/fallbackSwitch, shared/ui/posterSwitch,
// shared/device/cardOpenSwitch, shared/boot/homeBoot, shared/net/recoverSwitch,
// geo-nav/data/bootReadsSwitch,
// map/plateau/tapAnswerSwitch, map/plateau/lateFilesSwitch,
// map/plateau/coldTapSwitch, geo-nav/model/scopeHold,
// geo-nav/data/prefetchSwitch, map/plateau/lidCacheSwitch,
// geo-nav/model/slowSignSwitch, map/relief/groundSwitch, map/graphicsSwitch,
// map/threadSwitch, map/plateau/lidMapSwitch, map/plateau/lineMeshSwitch,
// map/plateau/riseSwitch,
// map/cacheBudget, analyses/devSwitch,
// shared/device/deviceTier, shared/device/motion). Under the « Appareil » row
// the dialog lists what the page knows of the device (`tierFacts`). Testing
// tools only: imported by DevOptionsMenu.vue
// alone, so a production build has none of these strings. French typography:
// a no-break space ( ) after « and before », ;, :, ? and %.

import type {
  DeviceSignals,
  DeviceTier,
  TierReason,
  TierVerdict,
} from "@/shared/device/deviceTier";

export type DevSection = "donnees" | "carte" | "analyses" | "appareil" | "site";

export type DevKey =
  | "ac:data-source"
  | "ac:place-tree"
  | "ac:lid"
  | "ac:lid-check"
  | "ac:mesh"
  | "ac:relief-prefetch"
  | "ac:frame-fill"
  | "ac:tap-answer"
  | "ac:tap-frame"
  | "ac:late-files"
  | "ac:outline-wait"
  | "ac:region-self"
  | "ac:cold-start"
  | "ac:scope-drag"
  | "ac:outlines-ahead"
  | "ac:lid-cache"
  | "ac:slow-sign"
  | "ac:analyses-pending"
  | "ac:slab-lid-verre"
  | "ac:slab-text"
  | "ac:slab-size"
  | "ac:ring-band"
  | "ac:tier"
  | "ac:boot-list"
  | "ac:boot-workers"
  | "ac:outlines-decor"
  | "ac:glyphs"
  | "ac:map-preload"
  | "ac:glass"
  | "ac:auth-client"
  | "ac:map-fallback"
  | "ac:poster"
  | "ac:card-open"
  | "ac:home-boot"
  | "ac:hero"
  | "ac:recover"
  | "ac:filters-load"
  | "ac:prefetch"
  | "ac:relief-ground"
  | "ac:msaa"
  | "ac:dpr"
  | "ac:frame-measure"
  | "ac:lines-mesh"
  | "ac:globe-late"
  | "ac:tint-cut"
  | "ac:pins-rebuild"
  | "ac:lid-map"
  | "ac:map-caches"
  | "ac:line-mesh"
  | "ac:motion"
  | "ac:rise"
  | "ac:rise-order";

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

/** The mark of a row whose choice is not the default, and of the dialog's top line. */
export const DEV_CHANGED_MARK = "modifié";
export const DEV_NONE_CHANGED = "Aucun choix modifié.";
export const DEV_RESET_LABEL = "Tout remettre par défaut";
/** "1 choix modifié", "3 choix modifiés": the top line's and the DEV button's count. */
export const changedCount = (n: number) => `${n} choix ${DEV_CHANGED_MARK}${n > 1 ? "s" : ""}`;

export const DEV_SECTIONS: readonly { id: DevSection; title: string; intro: string }[] = [
  {
    id: "donnees",
    title: "Données",
    intro: "D'où viennent les chiffres, et la liste des lieux des Filtres.",
  },
  {
    id: "carte",
    title: "Carte",
    intro: "Son chargement, le relief du territoire choisi et son cadrage.",
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
  {
    id: "site",
    title: "Site",
    intro: "Le chargement des pages, hors de la carte.",
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
      "D'où la page tire ses chiffres et ses listes. « Serveur » (par défaut, comme le site public) les demande au serveur ; « Corpus » télécharge tous les témoignages et compte dans la page ; « Comparer » affiche ceux du serveur, recompte à côté et signale les écarts (pastille Δ). Avec « Corpus » et « Comparer », la carte ne montre que les points des lieux : elle ne trace pas le contour des territoires, ne soulève pas en relief celui qui est choisi et ne pose pas les analyses autour de lui.",
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
    key: "ac:boot-list",
    section: "carte",
    label: "Liste",
    choices: [
      { id: "first", label: "D'abord" },
      { id: "curtain", label: "Rideau" },
    ],
    explain:
      "Pendant que la carte se prépare à l'ouverture de la page. « D'abord » (par défaut) montre la liste des lieux dès qu'elle est prête, et la carte seule reste couverte jusqu'à ce qu'elle soit dessinée : un lieu choisi entre-temps s'ouvre aussitôt dans la liste, puis sur la carte. « Rideau », l'ancien comportement, couvre la liste et la carte ensemble jusqu'à ce que tout soit prêt.",
    reloads: true,
    defaultId: "first",
  },
  {
    key: "ac:boot-workers",
    section: "carte",
    label: "Assistants",
    choices: [
      { id: "early", label: "Tôt" },
      { id: "load", label: "Au chargement" },
    ],
    explain:
      "Deux calculs en arrière-plan préparent le territoire en relief : sa forme et son relief. « Tôt » (par défaut) les lance dès l'ouverture de la page, pendant que la carte se charge, et le premier territoire se soulève plus vite ; « Au chargement », l'ancien comportement, attend que la carte ait fini de se charger.",
    reloads: true,
    defaultId: "early",
  },
  {
    key: "ac:outlines-decor",
    section: "carte",
    label: "Contours voisins",
    choices: [
      { id: "after", label: "Après" },
      { id: "boot", label: "Au début" },
    ],
    explain:
      "Les traits fins des autres pays, autour du pays choisi, ne servent qu'au décor. « Après » (par défaut) les charge une fois le premier territoire soulevé, sans gêner ce qu'il lui faut, et les pose quand la carte est immobile : ils arrivent un peu plus tard. « Au début », l'ancien comportement, les charge tous dès que la carte apparaît.",
    reloads: true,
    defaultId: "after",
  },
  {
    key: "ac:glyphs",
    section: "carte",
    label: "Police des noms",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "mapbox", label: "Mapbox" },
      { id: "local", label: "Site" },
    ],
    explain:
      "Les lettres des noms de lieux écrits sur la carte. « Auto » (par défaut) prend la police du site sur un appareil de niveau « Léger » ou « Minimal » (voir « Niveau »), et celle de Mapbox sur les autres. « Mapbox », comme avant, télécharge les lettres de la carte en une douzaine de fichiers avant de l'afficher ; « Site » les dessine avec la police du site, déjà chargée : la carte s'affiche plus tôt, mais les noms changent d'allure (gras plus marqués, noms des mers et des fleuves sans italique).",
    reloads: true,
    defaultId: "auto",
  },
  {
    key: "ac:map-preload",
    section: "carte",
    label: "Code de la carte",
    choices: [
      { id: "html", label: "Tôt" },
      { id: "page", label: "Avec la page" },
    ],
    explain:
      "Le gros fichier du code de la carte, sur la page des témoignages. « Tôt » (par défaut) le demande dès l'arrivée, en même temps que le reste du site : la liste et la carte arrivent un peu plus tôt, mais la toute première image de la page un peu plus tard. « Avec la page », l'ancien comportement, ne le demande qu'une fois la page lancée.",
    reloads: true,
    defaultId: "html",
  },
  {
    key: "ac:map-fallback",
    section: "carte",
    label: "Carte indisponible",
    choices: [
      { id: "visiteur", label: "Visiteur" },
      { id: "ancien", label: "Ancien" },
      { id: "essai", label: "Essai" },
    ],
    explain:
      "Ce que montre le cadre de la carte quand elle ne peut pas démarrer (navigateur sans affichage 3D, clé de la carte refusée). « Visiteur » (par défaut) montre la France en image, en retrait, sous une phrase simple ; « Ancien » affiche la phrase destinée aux développeurs, comme avant ; « Essai » ne démarre pas la carte du tout, pour voir ce cadre sur n'importe quel appareil.",
    reloads: true,
    defaultId: "visiteur",
  },
  {
    key: "ac:poster",
    section: "carte",
    label: "Image d'attente",
    choices: [
      { id: "non", label: "Non" },
      { id: "france", label: "France" },
    ],
    explain:
      "Pendant le chargement de la carte, son cadre montre un indicateur de chargement sur un fond uni (« Non », par défaut, comme avant) ou, derrière lui, la France et ses régions en image, en retrait (« France ») : le cadre a une image dès l'ouverture de la page, jusqu'à ce que la vraie carte la remplace.",
    reloads: true,
    defaultId: "non",
  },
  {
    key: "ac:tap-answer",
    section: "carte",
    label: "Réponse au toucher",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "stroke", label: "Contour" },
      { id: "fill", label: "Violet" },
      { id: "off", label: "Aucune" },
    ],
    explain:
      "Quand on touche ou clique un territoire, il est marqué tout de suite, en attendant qu'il se soulève. « Auto » (par défaut) trace un contour clair et épais autour de lui et, sur un écran tactile, le remplit aussi de violet ; « Contour » ne trace que le contour ; « Violet » ne fait que le remplir, sur tous les appareils ; « Aucune » ne marque rien, comme avant. Avec les trois premiers choix, l'étiquette du territoire s'affiche aussi, en violet.",
    reloads: false,
    defaultId: "auto",
  },
  {
    key: "ac:tap-frame",
    section: "carte",
    label: "Image du toucher",
    choices: [
      { id: "same", label: "Même image" },
      { id: "own", label: "Image à part" },
    ],
    explain:
      "À quel moment la marque du territoire touché est dessinée. « Même image » (par défaut) la dessine en même temps que le départ de la carte vers ce territoire, sans rien retarder ; « Image à part » la dessine d'abord, seule, et lance tout le reste une image plus tard. Sans effet si Réponse au toucher est « Aucune ».",
    reloads: false,
    defaultId: "same",
    inactiveWhen: { key: "ac:tap-answer", id: "off" },
  },
  {
    key: "ac:late-files",
    section: "carte",
    label: "Fichiers tardifs",
    choices: [
      { id: "quiet", label: "Au calme" },
      { id: "direct", label: "Direct" },
    ],
    explain:
      "Les contours arrivent par fichiers, et certains arrivent après coup : les communes d'un département, les voisins, le fichier d'un territoire déjà quitté. « Au calme » (par défaut) les garde de côté et ne les trace qu'une fois la carte immobile, tous d'un coup, sans faire redescendre ni remonter le relief ; « Direct » les trace dès qu'ils arrivent, même en plein déplacement, comme avant.",
    reloads: true,
    defaultId: "quiet",
  },
  {
    key: "ac:outline-wait",
    section: "carte",
    label: "Attente du contour",
    choices: [
      { id: "1200", label: "1,2 s" },
      { id: "400", label: "0,4 s" },
      { id: "0", label: "Aucune" },
    ],
    explain:
      "Le contour précis d'un territoire arrive par un fichier. S'il tarde, la carte soulève le territoire sur un contour plus grossier qu'elle a déjà, puis met le contour précis à sa place, sans le faire redescendre, une fois la carte immobile. « 1,2 s » (par défaut) attend le fichier jusqu'à 1,2 seconde, comme avant ; « 0,4 s » l'attend moins longtemps ; « Aucune » ne l'attend pas : le territoire se soulève tout de suite sur le contour grossier. Sans contour grossier déjà là, l'attente reste de 1,2 seconde.",
    reloads: false,
    defaultId: "1200",
  },
  {
    key: "ac:region-self",
    section: "carte",
    label: "Contour seul",
    choices: [
      { id: "first", label: "D'abord" },
      { id: "bundle", label: "Ensemble" },
    ],
    explain:
      "Le contour d'une région existe en deux fichiers : un petit, la région seule, et un gros, la région avec tous ses départements. « D'abord » (par défaut) demande le petit en premier : la région se soulève dès qu'il est là, et les lignes de ses départements sont tracées dessus quand le gros arrive, une fois la carte immobile. « Ensemble » attend le gros fichier, comme avant : la région se soulève plus tard, ses départements déjà tracés. De même pour un département et ses communes.",
    reloads: false,
    defaultId: "first",
  },
  {
    key: "ac:cold-start",
    section: "carte",
    label: "Avant le contour",
    choices: [
      { id: "hold", label: "Attendre" },
      { id: "early", label: "Commencer" },
    ],
    explain:
      "Ce que fait la carte quand on choisit un territoire dont le contour n'est pas encore arrivé. « Attendre » (par défaut) laisse le territoire d'avant soulevé jusqu'à l'arrivée du contour, comme avant ; « Commencer » le fait redescendre tout de suite et prépare déjà l'image du dessus du nouveau relief, pour que celui-ci se soulève plus vite une fois son contour arrivé.",
    reloads: false,
    defaultId: "hold",
  },
  {
    key: "ac:scope-drag",
    section: "carte",
    label: "Glisser la carte",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "keep", label: "Garder" },
      { id: "follow", label: "Suivre" },
    ],
    explain:
      "Ce que devient le territoire choisi quand on fait glisser la carte. « Auto » (par défaut) fait « Garder » sur un écran tactile et « Suivre » avec une souris ; « Garder » laisse le territoire choisi tant qu'une partie de lui reste visible : il ne change que s'il sort presque entièrement de la vue, ou si on dézoome au-delà de lui ; « Suivre » passe au territoire qui se trouve au centre de la vue dès que le centre quitte le territoire choisi, comme avant.",
    reloads: false,
    defaultId: "auto",
  },
  {
    key: "ac:outlines-ahead",
    section: "carte",
    label: "Contours d'avance",
    choices: [
      { id: "idle", label: "Au repos" },
      { id: "off", label: "Jamais" },
    ],
    explain:
      "Sur un écran tactile, la page peut télécharger d'avance le contour de quelques territoires, pour qu'ils se soulèvent sans attendre ce fichier quand on les touche. « Au repos » (par défaut) télécharge celui des deux régions qui comptent le plus de témoignages (une seule sur un appareil lent), une fois la France soulevée et la carte immobile ; rien si le navigateur demande d'économiser les données ou annonce une connexion lente. « Jamais » ne télécharge rien d'avance, comme avant. Avec une souris, rien ne change : le contour d'un territoire est demandé quand le pointeur s'arrête sur sa ligne dans la liste.",
    reloads: false,
    defaultId: "idle",
  },
  {
    key: "ac:lid-cache",
    section: "carte",
    label: "Images gardées",
    choices: [
      { id: "on", label: "Oui" },
      { id: "off", label: "Non" },
    ],
    explain:
      "Le dessus du relief est une image de la carte, que la page fabrique pour chaque territoire choisi. « Oui » (par défaut) garde les dernières images, deux à quatre selon l'appareil : quand on revient sur un territoire déjà vu, il se soulève tout de suite avec son image, sans que la page la refasse. « Non » refait l'image à chaque fois, comme avant. Sans effet si Couvercle est « Ancien » ou « Aucun ».",
    reloads: false,
    defaultId: "on",
  },
  {
    key: "ac:slow-sign",
    section: "carte",
    label: "Attente longue",
    choices: [
      { id: "on", label: "Signe" },
      { id: "off", label: "Rien" },
    ],
    explain:
      "Quand un territoire touché tarde à se soulever. « Signe » (par défaut) : une fois la carte arrivée sur lui, et au plus tôt 0,8 seconde après le toucher, trois petits points bougent à côté de son étiquette sur la carte et de son nom dans le panneau, jusqu'à ce qu'il se soulève ; ils restent immobiles si l'appareil demande moins d'animations. Au bout de 5 secondes sans rien, la marque du territoire s'efface et le panneau dit « La carte met plus de temps que prévu. », avec un bouton « Réessayer » qui redemande seulement ce qui manque. « Rien » ne montre ni points ni message, comme avant. Sans effet si Réponse au toucher est « Aucune ».",
    reloads: false,
    defaultId: "on",
    inactiveWhen: { key: "ac:tap-answer", id: "off" },
  },
  {
    key: "ac:relief-ground",
    section: "carte",
    label: "Sol",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "relief", label: "Relief" },
      { id: "flat", label: "Plat" },
    ],
    explain:
      "Ce qui se passe sous le territoire choisi quand il se soulève. « Auto » (par défaut) suit le niveau de l'appareil (section Appareil) : « Relief » au niveau complet, « Plat » aux niveaux léger et minimal. Avec « Relief », le sol monte avec le territoire. Avec « Plat », le sol reste en bas : seuls les parois et le dessus montent, ce qui demande moins de calcul, et les points des lieux sont posés sur le dessus. Le choix vaut à partir du prochain territoire choisi.",
    reloads: false,
    defaultId: "auto",
  },
  {
    key: "ac:lines-mesh",
    section: "carte",
    label: "Traits seuls",
    choices: [
      { id: "worker", label: "Arrière-plan" },
      { id: "page", label: "Page" },
    ],
    explain:
      "Quand aucun territoire n'est soulevé (« Monde », par exemple), la carte ne trace que les contours. « Arrière-plan » (par défaut) prépare ces contours hors de la page, comme pour un territoire en relief : la page ne se fige pas, et ils arrivent quand l'ancien relief a fini de redescendre. « Page » les prépare dans la page, comme avant. Sans effet si Maillage n'est pas sur son dernier choix.",
    reloads: false,
    defaultId: "worker",
  },
  {
    key: "ac:globe-late",
    section: "carte",
    label: "Globe",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "page", label: "Page" },
      { id: "wait", label: "Attendre" },
    ],
    explain:
      "Un territoire vu de près reçoit d'abord sa forme pour la carte à plat ; sa forme pour le globe (la vue de très loin) est préparée à part, hors de la page. Si le globe s'affiche avant qu'elle soit prête, « Auto » (par défaut) la demande plus tôt, puis fait comme « Page » au niveau complet de l'appareil (section Appareil) et comme « Attendre » aux niveaux léger et minimal. « Page » la calcule dans la page, qui peut se figer un instant, comme avant. « Attendre » la demande plus tôt et, tant qu'elle n'est pas là, ne dessine ni le relief ni les contours, pendant quelques images.",
    reloads: false,
    defaultId: "auto",
  },
  {
    key: "ac:tint-cut",
    section: "carte",
    label: "Gris",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "worker", label: "Arrière-plan" },
      { id: "page", label: "Page" },
    ],
    explain:
      "Autour du territoire choisi, la carte est grisée ; ce gris est redécoupé à chaque nouveau choix. « Auto » (par défaut) suit le niveau de l'appareil (section Appareil) : « Page » au niveau complet, « Arrière-plan » aux niveaux léger et minimal. « Page » fait ce découpage dans la page, au moment du toucher, comme avant : le territoire touché s'éclaircit aussitôt. « Arrière-plan » le fait hors de la page, qui a moins à calculer : le territoire touché s'éclaircit quelques images plus tard. Sans effet si Maillage n'est pas sur son dernier choix.",
    reloads: false,
    defaultId: "auto",
  },
  {
    key: "ac:pins-rebuild",
    section: "carte",
    label: "Points",
    choices: [
      { id: "next", label: "Image suivante" },
      { id: "now", label: "Tout de suite" },
    ],
    explain:
      "Quand les lieux à montrer changent, la carte met à jour ses points et les zones où un clic choisit un territoire. « Image suivante » (par défaut) le fait juste après l'image qui suit le toucher, pour que cette première image arrive plus vite. « Tout de suite » le fait au moment du toucher, comme avant.",
    reloads: false,
    defaultId: "next",
  },
  {
    key: "ac:lid-map",
    section: "carte",
    label: "Carte cachée",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "boot", label: "Démarrage" },
      { id: "first-place", label: "Premier lieu" },
      { id: "none", label: "Aucune" },
    ],
    explain:
      "L'image du dessus du relief est prise sur une deuxième carte, que la page dessine sans la montrer. « Auto » (par défaut) suit le niveau de l'appareil (section Appareil) : « Premier lieu » aux niveaux complet et léger, « Aucune » au niveau minimal. « Démarrage » crée cette carte dès que la carte visible est prête, sur une vue du monde entier, comme avant. « Premier lieu » la crée au même moment, mais directement sur le premier territoire à soulever : elle ne charge que ce qui sert à sa première image. « Aucune » ne la crée pas : le dessus du relief n'a pas d'image, et l'on voit la carte elle-même entre les parois. Sans effet si Couvercle est « Aucun » ; avec « Ancien », « Premier lieu » fait comme « Démarrage ».",
    reloads: true,
    defaultId: "auto",
    inactiveWhen: { key: "ac:lid", id: "aucun" },
  },
  {
    key: "ac:line-mesh",
    section: "carte",
    label: "Traits",
    choices: [
      { id: "lean", label: "Allégés" },
      { id: "full", label: "Entiers" },
    ],
    explain:
      "Les traits violets des limites (communes, départements, régions, pays) sont remis à la puce graphique sous une forme plus ou moins lourde. « Allégés » (par défaut) remet chaque segment une seule fois, sous une forme huit fois plus petite, et ne trace qu'une fois la limite que deux territoires voisins partagent sur le dessus du relief : la carte occupe moins de mémoire, et l'image est la même. « Entiers » remet tout comme avant.",
    reloads: true,
    defaultId: "lean",
  },
  {
    key: "ac:rise",
    section: "carte",
    label: "Montée",
    choices: [
      { id: "steps", label: "Pas à pas" },
      { id: "transition", label: "Continue" },
    ],
    explain:
      "Comment le sol monte et redescend avec le territoire choisi. « Pas à pas » (par défaut) redonne à la carte la hauteur du sol à chaque image, comme avant : la carte redessine alors tout le sol à chaque image. « Continue » lui donne la hauteur d'arrivée une seule fois et la laisse y aller seule, les parois et le dessus suivant le sol image par image : la carte a moins à redessiner, et le mouvement part plus doucement. Sans effet quand le sol reste plat (choix « Sol »).",
    reloads: false,
    defaultId: "steps",
  },
  {
    key: "ac:rise-order",
    section: "carte",
    label: "Ordre",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "flight", label: "En vol" },
      { id: "after", label: "À l'arrivée" },
    ],
    explain:
      "Le moment où le territoire choisi se soulève. « Auto » (par défaut) suit le niveau de l'appareil (section Appareil) : « En vol » au niveau complet, « À l'arrivée » aux niveaux léger et minimal. « En vol » le soulève pendant que la carte se déplace vers lui, comme avant. « À l'arrivée » attend que la carte soit arrivée : pendant le déplacement le territoire reste à plat, ses contours déjà tracés, puis il monte ; la carte a moins à calculer pendant qu'elle bouge.",
    reloads: false,
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
      "Le niveau de puissance retenu pour cet appareil. « Auto » (par défaut) le déduit des signaux listés ci-dessous : peu de mémoire, peu de cœurs, l'économie de données ou une connexion lente donnent « Léger » ; un affichage calculé sans puce graphique donne « Minimal » ; des images trop lentes pendant un déplacement de la carte font descendre d'un niveau ou de deux. Les trois autres choix imposent un niveau. Pour l'instant, la police des noms de la carte, le sol sous le territoire choisi, le verre des panneaux, l'ouverture de la carte de l'accueil et la carte de l'accueil elle-même (une image sur un appareil faible) en dépendent (voir « Police des noms », « Sol », « Verre dépoli » et « Ouverture de la carte »).",
    reloads: true,
    defaultId: "auto",
  },
  {
    key: "ac:glass",
    section: "appareil",
    label: "Verre dépoli",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "flou", label: "Flou" },
      { id: "plein", label: "Plein" },
    ],
    explain:
      "Le verre dépoli des panneaux (le panneau des lieux, l'en-tête, les étiquettes des analyses, le bouton de la carte de l'accueil). « Auto » (par défaut) floute ce qu'il y a derrière sur un appareil de niveau « Complet » et le laisse net sur un appareil « Léger » ou « Minimal » (voir « Niveau »), car le flou se redessine à chaque mouvement de la carte. « Flou » floute sur tous les appareils ; « Plein » sur aucun, le verre un peu plus opaque : c'est ainsi que Chrome affichait le site jusqu'ici.",
    reloads: true,
    defaultId: "auto",
  },
  {
    key: "ac:card-open",
    section: "appareil",
    label: "Ouverture de la carte",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "grandir", label: "Grandir" },
      { id: "direct", label: "Directe" },
    ],
    explain:
      "Quand on touche la carte de l'accueil, elle grandit jusqu'à occuper la page des témoignages (« Grandir », comme avant) ou la page apparaît aussitôt (« Directe », comme quand le système demande moins d'animations). « Auto » (par défaut) fait grandir la carte sur un appareil de niveau « Complet » et ouvre la page aussitôt sur un appareil « Léger » ou « Minimal » (voir « Niveau »), où chaque image de l'agrandissement redessine toute la carte.",
    reloads: true,
    defaultId: "auto",
  },
  {
    key: "ac:msaa",
    section: "appareil",
    label: "Lissage",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "on", label: "Activé" },
      { id: "off", label: "Coupé" },
    ],
    explain:
      "Le lissage, par la puce graphique, des bords du territoire en relief (ses parois, son dessus, ses traits). « Auto » (par défaut) le coupe seulement quand l'affichage est lent (ligne « Affichage lent » ci-dessous) ; « Activé » le garde toujours, comme avant ; « Coupé » l'enlève toujours : ces bords sont alors un peu en escalier, le fond de carte et ses textes ne changent pas.",
    reloads: true,
    defaultId: "auto",
  },
  {
    key: "ac:dpr",
    section: "appareil",
    label: "Finesse",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "native", label: "Écran" },
      { id: "1.5", label: "1,5" },
    ],
    explain:
      "Le nombre de points que la carte dessine pour chaque point de la page. « Auto » (par défaut) et « Écran » suivent la finesse de l'écran, comme avant ; « 1,5 » s'arrête à une fois et demie : sur un écran très fin, la carte et ses textes sont un peu plus flous et demandent moins de calcul, le reste de la page ne change pas. Pour l'instant « Auto » ne réduit jamais, même quand l'affichage est lent : la carte n'a pas de réglage prévu pour cela, ce choix sert à juger l'effet à l'œil.",
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
      "Au premier déplacement animé de la carte vers un territoire, la page chronomètre les images. « Activée » (par défaut) : si elles sont trop lentes, le niveau de l'appareil descend, et ce résultat est gardé trente jours dans ce navigateur (ligne « Images mesurées » ci-dessous). « Coupée » : rien n'est chronométré, comme avant.",
    reloads: true,
    defaultId: "on",
  },
  {
    key: "ac:map-caches",
    section: "appareil",
    label: "Mémoire",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "large", label: "Grande" },
      { id: "small", label: "Petite" },
    ],
    explain:
      "Ce que la carte garde en mémoire pour revenir plus vite sur un endroit déjà vu : des morceaux de carte, la forme des territoires déjà soulevés et leur relief. « Auto » (par défaut) suit le niveau de l'appareil : « Grande » au niveau complet, « Petite » aux niveaux léger et minimal. « Grande » garde autant qu'avant. « Petite » garde trois à cinq fois moins : la page occupe moins de mémoire, et le retour sur un endroit vu depuis longtemps peut demander un court rechargement.",
    reloads: true,
    defaultId: "auto",
  },
  {
    key: "ac:motion",
    section: "appareil",
    label: "Mouvement",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "full", label: "Complet" },
      { id: "short", label: "Court" },
    ],
    explain:
      "Les mouvements de la carte et du panneau. « Auto » (par défaut) suit l'appareil : « Court » si le système demande de réduire les animations ou si le niveau de l'appareil est léger ou minimal, « Complet » sinon. « Complet » joue tout comme avant : à l'arrivée la carte s'incline en une seconde, le territoire choisi monte en un tiers de seconde, le panneau s'élargit et une audition se déplie en glissant, la carte prend du recul pour passer d'un résultat à un autre. « Court » : la carte s'incline d'un coup, le territoire monte plus vite, le panneau et l'audition s'ouvrent d'un coup, la carte va tout droit d'un résultat à l'autre. Les autres déplacements de la carte ne changent pas.",
    reloads: false,
    defaultId: "auto",
  },
  {
    key: "ac:auth-client",
    section: "site",
    label: "Connexion",
    choices: [
      { id: "demande", label: "À la demande" },
      { id: "demarrage", label: "Au démarrage" },
    ],
    explain:
      "Le code de la connexion aux comptes, environ 47 ko compressés. « À la demande » (par défaut) ne le télécharge que pour un visiteur déjà connecté, au retour d'un lien reçu par e-mail ou sur la page de connexion : les autres visiteurs ont des pages plus légères. « Au démarrage », l'ancien comportement, le télécharge sur toutes les pages dès l'ouverture.",
    reloads: true,
    defaultId: "demande",
  },
  {
    key: "ac:home-boot",
    section: "site",
    label: "Accueil",
    choices: [
      { id: "tot", label: "Tôt" },
      { id: "ancien", label: "Ancien" },
    ],
    explain:
      "La toute première image des pages. « Tôt » (par défaut) met le thème clair ou sombre dès la première image, et sur l'accueil peint le fond sombre de la photo tout de suite et demande le code de l'accueil en même temps que celui du site. « Ancien », comme avant, peut montrer un instant la page claire puis sombre, et une page vide jusqu'à ce que le code de l'accueil soit arrivé.",
    reloads: true,
    defaultId: "tot",
  },
  {
    key: "ac:hero",
    section: "site",
    label: "Photo de l'accueil",
    choices: [
      { id: "portrait", label: "Portrait" },
      { id: "html", label: "Portrait tôt" },
      { id: "ancien", label: "Ancien" },
    ],
    explain:
      "La grande photo de l'accueil. « Portrait » (par défaut) envoie aux écrans en hauteur (téléphones, tablettes tenues droites) une copie découpée à leur forme, un peu plus compressée : environ 240 ko sur un téléphone au lieu de 760 ko, le même cadrage. « Portrait tôt » la demande en plus dès l'arrivée sur la page, en même temps que le code du site : un essai, pas encore mesuré. « Ancien » envoie la même grande copie à tous les écrans, et Safari en télécharge alors deux ou trois tailles l'une après l'autre.",
    reloads: true,
    defaultId: "portrait",
  },
  {
    key: "ac:recover",
    section: "site",
    label: "Reprise après coupure",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "ancien", label: "Ancien" },
    ],
    explain:
      "Ce que fait la page des témoignages quand le réseau manque. « Auto » (par défaut) redemande d'elle-même ce qui n'a pas pu venir, après 2, 5, 10, 20 puis 30 secondes, puis dès que le navigateur retrouve le réseau ou que la page revient à l'écran : les contours de la carte, la liste des lieux, les résultats. En attendant, le panneau le dit en une phrase, avec un bouton « Réessayer ». « Ancien », comme avant : la carte reste sans contours jusqu'au prochain chargement de la page, et le reste n'est redemandé qu'en changeant de lieu.",
    reloads: true,
    defaultId: "auto",
  },
  {
    key: "ac:filters-load",
    section: "site",
    label: "Données des filtres",
    choices: [
      { id: "repos", label: "Au repos" },
      { id: "ouverture", label: "À l'ouverture" },
      { id: "demarrage", label: "Au démarrage" },
    ],
    explain:
      "Quand la page demande ce que seule la fenêtre des filtres affiche : la liste de tous les lieux et le nombre de témoignages par thème. « Au repos » (par défaut) attend que la liste des lieux soit affichée, puis trois secondes et un moment calme : le démarrage a deux demandes de moins. « À l'ouverture » attend que la fenêtre des filtres s'ouvre, qui montre alors un instant son chargement. « Au démarrage », comme avant, les demande dès l'arrivée sur la page.",
    reloads: true,
    defaultId: "repos",
  },
  {
    key: "ac:prefetch",
    section: "site",
    label: "Préchargement des témoignages",
    choices: [
      { id: "auto", label: "Auto" },
      { id: "trois", label: "Trois" },
      { id: "un", label: "Un" },
    ],
    explain:
      "Quand un lieu s'ouvre, la page demande à l'avance les premiers témoignages de ses premières auditions, pour qu'elles s'ouvrent aussitôt. « Auto » (par défaut) le fait pour trois auditions, et pour une seule quand le navigateur dit que le visiteur économise ses données ou que sa connexion est lente. « Trois », comme avant, le fait pour trois partout ; « Un » pour une seule partout : les suivantes montrent un instant leur chargement.",
    reloads: true,
    defaultId: "auto",
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
): DevFact[] {
  const why = detected.reasons.map((r) => REASON_LABELS[r]).join(", ");
  const m = signals.measured;
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
      value: m
        ? `${TIER_LABELS[m.tier]} (${KIND_LABELS[m.kind]}), le ${new Date(m.at).toLocaleDateString("fr-FR")}`
        : "aucune descente",
    },
  ];
}
