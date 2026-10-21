// The words of the fake testimonies. Everything here is invented for the seed:
// no sentence, name or description comes from a real testimony. Sentences are
// written the way people speak at a market stand, first person, from every
// side of the debate; a testimony is assembled from several of them.

/** The tags of the old vocabulary, as most stored testimonies carry them. */
export type Theme =
  | "démocratie"
  | "institutions"
  | "ruralité"
  | "écologie"
  | "climat"
  | "travail"
  | "santé"
  | "inégalités"
  | "fiscalité"
  | "services publics"
  | "pouvoir d'achat"
  | "retraites"
  | "solidarité"
  | "éducation"
  | "agriculture"
  | "transports"
  | "économie"
  | "logement"
  | "immigration"
  | "jeunesse"
  | "sécurité"
  | "médias"
  | "culture"
  | "énergie"
  | "justice"
  | "géopolitique"
  | "vie de quartier"
  | "handicap";

/** How often each tag appears on the real corpus (rounded), so the fake one
 *  draws the same mix. The two rarest are raised a little to be visible. */
export const THEME_WEIGHTS: Record<Theme, number> = {
  démocratie: 600,
  ruralité: 560,
  écologie: 550,
  institutions: 500,
  travail: 460,
  santé: 430,
  inégalités: 410,
  fiscalité: 410,
  "services publics": 390,
  "pouvoir d'achat": 370,
  retraites: 340,
  solidarité: 300,
  éducation: 240,
  agriculture: 220,
  transports: 200,
  économie: 190,
  logement: 170,
  immigration: 160,
  jeunesse: 140,
  sécurité: 140,
  climat: 130,
  médias: 120,
  culture: 110,
  énergie: 90,
  justice: 45,
  géopolitique: 40,
  "vie de quartier": 30,
  handicap: 20,
};

/** The 16-theme grid the AI tagger answers in, for the tags that have one. */
export const CANONICAL: Partial<Record<Theme, string>> = {
  santé: "Santé et accès aux soins",
  éducation: "Éducation",
  travail: "Emploi et conditions de travail",
  logement: "Logement",
  "pouvoir d'achat": "Pouvoir d'achat et inflation",
  retraites: "Retraites",
  inégalités: "Justice sociale et inégalités",
  démocratie: "Démocratie et institutions",
  institutions: "Démocratie et institutions",
  médias: "Médias et information",
  sécurité: "Sécurité et police",
  immigration: "Immigration",
  écologie: "Environnement et écologie",
  climat: "Environnement et écologie",
  géopolitique: "Guerre et géopolitique",
  "services publics": "Services publics",
  fiscalité: "Fiscalité",
  culture: "Culture et loisirs",
};

export const SENTENCES: Record<Theme, string[]> = {
  santé: [
    "Pour avoir un rendez-vous chez le dermatologue, il faut attendre huit mois, et encore, en appelant tous les matins à huit heures pile.",
    "Mon médecin traitant est parti à la retraite il y a deux ans et personne ne l'a remplacé, alors je vais aux urgences pour un simple renouvellement d'ordonnance.",
    "Aux urgences, j'ai attendu neuf heures sur un brancard dans le couloir avec ma mère de quatre-vingt-sept ans.",
    "Les infirmières font un travail énorme, mais on les épuise : dans mon service, trois collègues sont en arrêt pour épuisement.",
    "La téléconsultation, c'est pratique pour les jeunes, mais ma voisine ne sait pas allumer un ordinateur.",
    "On a fermé la maternité la plus proche ; maintenant il faut une heure de route pour accoucher, et l'hiver, avec la neige, c'est dangereux.",
    "Les dépassements d'honoraires, je ne peux pas suivre, alors je renonce à certains soins, surtout les dents et les lunettes.",
    "La santé mentale des jeunes, personne n'en parle : mon fils a attendu six mois pour voir un psychiatre.",
  ],
  éducation: [
    "Dans la classe de ma fille, ils sont vingt-neuf, avec trois enfants qui auraient besoin d'une aide qu'ils n'ont pas.",
    "On a eu quatre remplaçants différents en mathématiques cette année, les élèves ont complètement décroché.",
    "Je suis enseignante depuis vingt ans et je n'ai jamais autant rempli de papiers ; le temps passé devant les élèves diminue.",
    "L'orientation après le bac a été une angoisse pour toute la famille, mon fils ne comprenait pas pourquoi il était refusé partout.",
    "Il faudrait plus de formations professionnelles près de chez nous, les jeunes doivent partir à soixante kilomètres pour apprendre un métier.",
    "L'école du village va fermer une classe, et après ce sera l'école entière, c'est toujours comme ça que ça commence.",
    "Les accompagnants des élèves en situation de handicap sont payés une misère, alors ils ne restent pas.",
  ],
  travail: [
    "Je travaille à temps partiel imposé, vingt-quatre heures par semaine, et je cumule deux employeurs pour m'en sortir.",
    "Dans la logistique, on nous chronomètre pour tout ; à cinquante ans, j'ai le dos en compote.",
    "On parle beaucoup du télétravail, mais pour nous, les caissières, ça n'existe pas.",
    "J'ai monté mon entreprise il y a trois ans et je passe plus de temps à faire de l'administratif qu'à travailler.",
    "Les jeunes qu'on embauche partent au bout de six mois, parce qu'ils trouvent mieux ailleurs, et je les comprends.",
    "Le chômage, ce n'est pas des vacances : on se sent inutile, et on vous regarde de travers.",
    "Mon contrat d'intérim est renouvelé de semaine en semaine depuis un an, impossible d'obtenir un prêt ou un appartement.",
  ],
  logement: [
    "Je paie la moitié de mon salaire en loyer pour un deux-pièces mal isolé.",
    "On a fait une demande de logement social il y a six ans, toujours rien, pas même un rendez-vous.",
    "Dans notre immeuble, l'ascenseur est en panne depuis trois mois et une voisine en fauteuil ne peut plus sortir.",
    "Les locations touristiques ont vidé le centre-ville, il n'y a plus de familles, plus d'enfants à l'école.",
    "Mon fils de vingt-cinq ans vit encore chez nous parce qu'il ne trouve rien à louer sans garant.",
    "Les propriétaires ne veulent pas faire les travaux d'isolation et c'est nous qui payons le chauffage.",
  ],
  "pouvoir d'achat": [
    "Le caddie qui me coûtait cent euros il y a trois ans m'en coûte cent cinquante aujourd'hui.",
    "À la fin du mois, on choisit entre le plein d'essence et les courses.",
    "Je fais attention à tout, je compare les prix, je ne vais plus au restaurant, et pourtant ça ne suffit pas.",
    "Les factures d'électricité ont doublé, j'ai coupé le chauffage dans deux pièces.",
    "Je ne demande pas la charité, je demande de pouvoir vivre de mon travail.",
    "Les enfants me demandent des choses que je ne peux pas leur offrir, et c'est dur à expliquer.",
  ],
  retraites: [
    "J'ai commencé à travailler à seize ans, et à soixante-trois ans on me dit encore d'attendre.",
    "Ma retraite d'agricultrice ne dépasse pas huit cents euros après quarante-deux ans de travail.",
    "Les femmes qui se sont arrêtées pour élever les enfants le paient toute leur vie à la retraite.",
    "Je suis retraité et j'aide mes petits-enfants financièrement ; sans moi, ils ne s'en sortiraient pas.",
    "Il faut sauver le système, je veux bien l'entendre, mais pourquoi toujours sur le dos des mêmes ?",
    "Les métiers pénibles devraient partir plus tôt : un couvreur ne peut pas monter sur les toits à soixante-quatre ans.",
  ],
  inégalités: [
    "On a l'impression qu'il y a deux France qui ne se croisent plus.",
    "Quand on habite certains quartiers, l'adresse sur le CV suffit pour ne pas être rappelé.",
    "Les aides existent, mais il faut être un expert pour les obtenir, les dossiers sont interminables.",
    "Les plus riches s'en sortent toujours, et ce sont les classes moyennes qui paient pour tout le monde.",
    "Ma fille est aussi diplômée que son collègue et elle gagne vingt pour cent de moins.",
    "Le handicap, c'est encore une double peine : moins de travail, moins de revenus, et des bâtiments inaccessibles.",
  ],
  démocratie: [
    "On vote, et après on n'entend plus parler de nous jusqu'à la prochaine élection.",
    "C'est la première fois qu'on me demande mon avis et qu'on l'écrit vraiment, merci pour ça.",
    "Il faudrait des référendums locaux sur les grands projets, pas seulement des réunions où tout est déjà décidé.",
    "Je ne vote plus depuis longtemps, non pas que je m'en fiche, mais je ne crois plus que ça change quelque chose.",
    "Les élus devraient venir sur le marché comme vous le faites aujourd'hui, pas seulement en période de campagne.",
    "Le tirage au sort pour des assemblées citoyennes, je trouve ça intéressant, à condition qu'on les écoute ensuite.",
    "Quand on manifeste, on nous traite de casseurs ; quand on se tait, on nous oublie.",
    "Les décisions sont prises trop loin, par des gens qui ne connaissent pas nos vies.",
  ],
  institutions: [
    "Le Parlement devrait avoir plus de poids, on gouverne trop à coups de décrets.",
    "La mairie, c'est encore le seul endroit où on est reçu par quelqu'un qui nous connaît.",
    "Les préfectures, c'est devenu impossible : tout passe par internet et personne ne répond.",
    "Je fais confiance à mon maire, beaucoup moins au reste.",
    "Il faudrait que les promesses de campagne soient suivies, qu'on puisse vérifier ce qui a été fait.",
    "Les réformes se succèdent tellement vite qu'on ne sait plus quelles sont les règles.",
  ],
  ruralité: [
    "Ici, sans voiture, on n'existe pas : le bus passe deux fois par jour, et pas pendant les vacances scolaires.",
    "La poste a fermé, la boulangerie aussi, il ne reste que le bar-tabac et il est à vendre.",
    "On nous parle de la fibre depuis cinq ans, on a toujours un débit qui ne permet pas de télétravailler.",
    "Les gens de la ville viennent l'été et trouvent ça joli, mais l'hiver nous sommes seuls.",
    "Le médecin le plus proche est à quarante minutes, et il ne prend plus de nouveaux patients.",
    "On aime notre village, mais il faut que les jeunes puissent y rester, avec du travail et des logements.",
    "Le déneigement des petites routes n'est plus assuré comme avant, on reste bloqués des journées entières.",
  ],
  écologie: [
    "On nous demande de trier, de baisser le chauffage, de prendre le vélo, pendant que les grandes entreprises continuent comme avant.",
    "Je veux bien changer ma voiture pour une électrique, mais avec quel argent ?",
    "Les étés sont de plus en plus chauds, dans mon appartement il fait trente-quatre degrés la nuit.",
    "Il faudrait plus d'arbres en ville, la place est un four en juillet.",
    "Le bio, c'est bien, mais c'est trop cher pour ma famille.",
    "On bétonne les terres agricoles autour de la ville pour construire des entrepôts.",
    "Mes enfants ont peur pour l'avenir de la planète, et je ne sais pas quoi leur répondre.",
  ],
  climat: [
    "Le glacier qu'on voyait depuis le village a presque disparu en vingt ans.",
    "Cet été, les sources ont tari et on a dû livrer l'eau par camion.",
    "Les orages sont plus violents, on a eu deux inondations en trois ans.",
    "La neige manque, la station ne tourne plus que deux mois, et c'est tout le village qui en souffre.",
  ],
  agriculture: [
    "Je suis agriculteur et je vends mon lait moins cher que ce qu'il me coûte à produire.",
    "Les normes changent tout le temps, on ne sait plus quoi faire, et on se sent montrés du doigt.",
    "On a besoin de jeunes pour reprendre les fermes, mais les terres sont trop chères.",
    "Les circuits courts nous ont sauvés : le marché du samedi, c'est un tiers de notre revenu.",
    "La sécheresse a détruit la moitié de la récolte de foin, il a fallu en racheter très cher.",
  ],
  transports: [
    "Le train pour la grande ville a été supprimé, il faut prendre un car puis un autre train, trois heures pour cent kilomètres.",
    "Les pistes cyclables s'arrêtent d'un coup au milieu d'un carrefour, c'est dangereux.",
    "Le métro est saturé aux heures de pointe, on ne peut même plus monter.",
    "L'essence me coûte deux cents euros par mois juste pour aller travailler.",
    "Il faudrait des bus le soir : après vingt heures, il n'y a plus rien pour rentrer.",
  ],
  "services publics": [
    "Pour refaire ma carte d'identité, il fallait un rendez-vous à trois mois et à trente kilomètres.",
    "Tout est dématérialisé, mais ma mère n'a pas internet ; c'est moi qui fais toutes ses démarches.",
    "La caisse d'allocations m'a réclamé deux mille euros de trop-perçu, sans explication, et personne au téléphone.",
    "Les guichets ferment les uns après les autres, on parle à des machines.",
    "Le service public, c'est ce qui reste à ceux qui n'ont rien, il ne faut pas le laisser tomber.",
    "Les agents font ce qu'ils peuvent, ce n'est pas leur faute, ils sont débordés.",
  ],
  fiscalité: [
    "Je paie mes impôts sans rechigner, mais je veux savoir à quoi ils servent.",
    "Les grandes entreprises qui font des milliards devraient payer au moins autant que la boulangerie du coin.",
    "La taxe foncière a augmenté de quinze pour cent cette année, pour une petite maison.",
    "On taxe le travail et pas assez le capital, c'est injuste.",
    "Il y a trop d'impôts en France, on étouffe ceux qui créent de l'activité.",
    "La TVA, tout le monde la paie pareil, le riche comme le pauvre, ce n'est pas juste.",
  ],
  solidarité: [
    "Je suis bénévole dans une épicerie solidaire, et cette année on voit des étudiants et des retraités qu'on ne voyait pas avant.",
    "Dans le quartier, on s'entraide entre voisins, c'est ce qui nous tient.",
    "Les associations font le travail que l'État ne fait plus, avec trois fois rien.",
    "Ma voisine âgée est seule toute la semaine ; si je ne passais pas, personne ne viendrait.",
  ],
  économie: [
    "Les petits commerces ferment les uns après les autres, il ne reste que des agences et des banques.",
    "On a délocalisé l'usine il y a quinze ans, la moitié de la ville a perdu son travail.",
    "Il faudrait produire en France, même si c'est un peu plus cher.",
    "Les taux d'intérêt ont monté, notre projet d'achat est tombé à l'eau.",
  ],
  immigration: [
    "Je suis arrivée en France il y a vingt ans, je travaille, je paie mes impôts, et on me demande encore d'où je viens.",
    "Il faut accueillir dignement, mais il faut aussi des moyens pour intégrer, apprendre la langue, trouver un travail.",
    "Dans notre quartier, on a parfois l'impression d'être laissés seuls pour gérer des situations difficiles.",
    "Les démarches pour un titre de séjour sont un parcours du combattant, des nuits entières dans la file.",
    "Beaucoup de métiers ne tourneraient pas sans les travailleurs étrangers, à l'hôpital comme sur les chantiers.",
    "Je pense qu'il faut mieux contrôler qui entre, sans pour autant tomber dans la haine.",
  ],
  jeunesse: [
    "Les jeunes n'ont rien à faire ici le soir, la maison des jeunes a fermé.",
    "On nous dit qu'on est la génération qui ne veut pas travailler, mais on enchaîne les stages non payés.",
    "Mon fils a vingt ans, il ne croit en rien, ni aux élus, ni à l'avenir.",
    "Le permis de conduire coûte deux mille euros : sans lui pas de travail, sans travail pas de permis.",
  ],
  sécurité: [
    "Le soir, je ne me sens pas en sécurité pour rentrer à pied de la gare.",
    "On ne voit plus de policiers à pied dans le quartier, seulement des voitures qui passent vite.",
    "Les trafics en bas de l'immeuble, tout le monde les voit, et rien ne change.",
    "La sécurité, ce n'est pas que la police, c'est aussi l'éclairage, les commerces ouverts, la vie dans la rue.",
    "Les contrôles d'identité, ce sont toujours les mêmes qui y passent.",
  ],
  médias: [
    "On ne sait plus quoi croire, entre les chaînes d'info et ce qui circule sur les réseaux.",
    "Les médias parlent des grandes villes, jamais de nous, sauf quand il y a un fait divers.",
    "Je ne regarde plus la télévision, je lis la presse locale, c'est plus proche de nos vies.",
    "Les fausses informations sur les réseaux font des dégâts dans les familles, on ne se parle plus.",
  ],
  culture: [
    "Le cinéma du village a fermé, il faut faire quarante kilomètres pour voir un film.",
    "La médiathèque, c'est le seul endroit chauffé et gratuit où les jeunes peuvent travailler.",
    "Les fêtes de village, les concerts, c'est ce qui crée du lien, il faut les soutenir.",
    "La culture ne devrait pas être un luxe, les places de spectacle sont hors de prix.",
  ],
  énergie: [
    "On a installé des panneaux solaires, il a fallu deux ans de démarches pour être raccordés.",
    "Les éoliennes divisent le village : certains y voient des revenus, d'autres un paysage gâché.",
    "Mon chauffage au fioul me coûte une fortune et je n'ai pas les moyens de le changer.",
  ],
  justice: [
    "La justice va trop lentement pour les victimes et trop vite pour les puissants.",
    "Mon fils a été victime d'un vol, la plainte a été classée sans suite en deux semaines.",
    "Il faudrait plus de juges et de greffiers, les tribunaux sont débordés.",
  ],
  géopolitique: [
    "La guerre aux portes de l'Europe m'angoisse, on n'imaginait pas revivre ça.",
    "Les conflits dans le monde font monter les prix ici, on le voit à la pompe.",
    "La France devrait parler davantage de paix et moins de ventes d'armes.",
  ],
  "vie de quartier": [
    "On voudrait un banc et un peu d'ombre sur la place, les anciens n'ont nulle part où s'asseoir.",
    "Le marché du samedi, c'est le cœur du quartier, il ne faut surtout pas le déplacer.",
    "Les poubelles débordent depuis que la collecte est passée à une fois par semaine.",
    "On a créé un jardin partagé au pied de l'immeuble, et depuis les voisins se parlent.",
  ],
  handicap: [
    "Mon fils autiste n'a pas de place en établissement, j'ai dû arrêter de travailler pour m'en occuper.",
    "Les trottoirs sont encombrés, avec mon fauteuil je dois descendre sur la route.",
  ],
};

export const OPENERS = [
  "Bonjour. Je voulais dire quelque chose qui me tient à cœur.",
  "Je ne suis pas spécialiste, mais je vais vous dire ce que je vis.",
  "Merci de prendre le temps de nous écouter, ce n'est pas si courant.",
  "Alors, par où commencer…",
  "Ce que je veux dire, c'est simple.",
  "Je vais parler pour moi, mais je sais que beaucoup pensent pareil.",
  "C'est un sujet dont on parle souvent entre voisins.",
  "J'habite ici depuis trente ans et j'ai vu les choses changer.",
  "Je ne fais pas de politique, mais il y a des choses qu'il faut dire.",
  "Je suis venue parce que ma fille m'a dit que c'était important.",
];

export const CLOSERS = [
  "Voilà, c'est tout ce que je voulais dire.",
  "J'espère que ça servira à quelque chose.",
  "Merci de nous avoir écoutés.",
  "Il faut que ça remonte jusqu'en haut.",
  "Je reviendrai la prochaine fois, s'il y en a une.",
  "On ne demande pas grand-chose, juste d'être entendus.",
  "Voilà ce que j'avais sur le cœur.",
];

/** Said between two parts of a longer testimony. */
export const LINKS = [
  "Et puis il y a autre chose.",
  "Autre chose, aussi.",
  "Pour revenir à ce que je disais tout à l'heure…",
  "Ce qui me frappe aussi, c'est ça.",
  "Je voudrais ajouter une chose.",
];

export const PERSON_INFOS = [
  "Retraitée, 72 ans",
  "Retraité du rail",
  "Aide-soignante",
  "Infirmier de nuit",
  "Étudiante en master",
  "Lycéen, 17 ans",
  "Agricultrice, 54 ans",
  "Éleveur de brebis",
  "Commerçant sur le marché",
  "Mère de trois enfants",
  "Père au foyer",
  "Artisan plombier",
  "Chauffeur de bus",
  "Professeure des écoles",
  "Demandeur d'emploi",
  "Auto-entrepreneuse",
  "Habitant du quartier depuis 30 ans",
  "Ouvrier dans la logistique",
  "Caissière",
  "Médecin généraliste",
  "Assistante maternelle",
  "Pompier volontaire",
  "Bénévole associatif",
  "Saisonnier en station",
  "Étudiant étranger",
  "Intérimaire",
  "Fonctionnaire territoriale",
  "Boulanger",
  "Maraîchère",
  "Ingénieur, 41 ans",
  "Sans emploi, 58 ans",
  "Aidante de son mari malade",
  "Jeune papa",
  "Militante associative",
  "Gérant de bar",
  "Coiffeuse",
  "Agent d'entretien",
  "Retraitée de l'enseignement",
  "Lycéenne",
  "Conducteur de travaux",
  "Mère célibataire",
  "Électricien",
  "Gardien d'immeuble",
  "Habitante du village",
  "Couple de retraités",
];

export const FIRST_NAMES = [
  "Marie",
  "Jean",
  "Nathalie",
  "Philippe",
  "Isabelle",
  "Patrick",
  "Sylvie",
  "Michel",
  "Catherine",
  "Pierre",
  "Sandrine",
  "Christophe",
  "Valérie",
  "Nicolas",
  "Céline",
  "Julien",
  "Aurélie",
  "Sébastien",
  "Émilie",
  "Thomas",
  "Camille",
  "Lucas",
  "Léa",
  "Hugo",
  "Chloé",
  "Louis",
  "Manon",
  "Nathan",
  "Inès",
  "Yanis",
  "Fatima",
  "Mohamed",
  "Karima",
  "Rachid",
  "Aïcha",
  "Mehdi",
  "Amadou",
  "Aminata",
  "Moussa",
  "Fatou",
  "Linh",
  "Kévin",
  "Jessica",
  "Bernard",
  "Monique",
  "Josiane",
  "Gérard",
  "Françoise",
  "René",
  "Odette",
  "Dylan",
  "Mélissa",
  "Sofia",
  "Yasmine",
  "Adam",
  "Jade",
  "Gabriel",
  "Emma",
  "Raphaël",
  "Alice",
  "Arthur",
  "Lina",
  "Ibrahim",
  "Mariam",
  "Vincent",
  "Laurence",
  "Hélène",
  "Joël",
  "Bruno",
  "Martine",
];

export const LAST_NAMES = [
  "Martin",
  "Bernard",
  "Dubois",
  "Thomas",
  "Robert",
  "Richard",
  "Petit",
  "Durand",
  "Leroy",
  "Moreau",
  "Simon",
  "Laurent",
  "Lefebvre",
  "Garcia",
  "David",
  "Bertrand",
  "Roux",
  "Vincent",
  "Fournier",
  "Morel",
  "Girard",
  "Mercier",
  "Blanc",
  "Guérin",
  "Boyer",
  "Faure",
  "Haddad",
  "Benali",
  "Diallo",
  "Nguyen",
  "Traoré",
  "Lopez",
];

/** What an audition's own text says (median ~65 characters on the real one). */
export const AUDITION_CONTENTS = [
  "Audition sur le marché, un samedi matin, au milieu des étals.",
  "Rencontre avec les passants devant la médiathèque.",
  "Audition en fin de journée, à la sortie des bureaux.",
  "Échanges sur la place du village après le marché.",
  "Audition organisée avec le comité de quartier.",
  "Rencontre à la sortie de l'école, avec des parents.",
  "Audition pendant la fête de quartier.",
  "Audition en salle des fêtes, une vingtaine de participants.",
  "Stand tenu un dimanche matin près de la boulangerie.",
  "Audition sous les arbres de la place, par grosse chaleur.",
  "Audition devant la gare, entre deux trains.",
  "Rencontre au café du village, autour d'une table.",
];

/** Testimonies written in another language, for the `world` profile. */
export const FOREIGN: Record<string, { text: string; themes: Theme[] }[]> = {
  en: [
    {
      text: "The nearest hospital is two hours away and the bus only runs twice a week. People here just stop seeing doctors.",
      themes: ["santé", "transports", "ruralité"],
    },
    {
      text: "My rent went up thirty percent this year. I work two jobs and still can't save anything.",
      themes: ["logement", "pouvoir d'achat", "travail"],
    },
    {
      text: "Nobody asks us what we think between elections. Thank you for actually writing it down.",
      themes: ["démocratie"],
    },
    {
      text: "The river flooded twice in three years, and the town keeps building on the flood plain anyway.",
      themes: ["écologie", "climat"],
    },
  ],
  es: [
    {
      text: "El precio de los alimentos se ha duplicado y los salarios siguen igual. Muchas familias ya no pueden comprar carne.",
      themes: ["pouvoir d'achat"],
    },
    {
      text: "En mi barrio no hay transporte público después de las nueve de la noche. Volver del trabajo es peligroso.",
      themes: ["transports", "sécurité"],
    },
    {
      text: "Los jóvenes se van del pueblo porque no hay trabajo. Solo quedan los abuelos.",
      themes: ["ruralité", "jeunesse", "travail"],
    },
    { text: "Queremos que nos escuchen antes de decidir, no después.", themes: ["démocratie"] },
  ],
  pt: [
    {
      text: "A escola do meu filho não tem professores suficientes. Ele passa metade do dia sem aulas.",
      themes: ["éducation"],
    },
    {
      text: "O posto de saúde fecha às três da tarde. Quem trabalha não consegue ser atendido.",
      themes: ["santé", "services publics"],
    },
    {
      text: "A água falta todos os verões e ninguém resolve o problema.",
      themes: ["écologie", "climat", "services publics"],
    },
    {
      text: "Os políticos só aparecem aqui em época de eleição.",
      themes: ["démocratie", "institutions"],
    },
  ],
  de: [
    {
      text: "Die Mieten in der Stadt sind so gestiegen, dass junge Familien wegziehen müssen.",
      themes: ["logement", "pouvoir d'achat"],
    },
    {
      text: "Der Bus in unser Dorf fährt nur noch zweimal am Tag. Ohne Auto geht hier nichts.",
      themes: ["transports", "ruralité"],
    },
    {
      text: "Ich wünsche mir, dass die Politik mehr zuhört und weniger verspricht.",
      themes: ["démocratie"],
    },
    {
      text: "In der Pflege arbeiten wir am Limit, viele Kolleginnen haben schon gekündigt.",
      themes: ["santé", "travail"],
    },
  ],
  it: [
    {
      text: "Nel mio paese hanno chiuso l'ufficio postale e la scuola. Restano solo gli anziani.",
      themes: ["ruralité", "services publics"],
    },
    {
      text: "I giovani laureati partono all'estero perché qui non trovano lavoro.",
      themes: ["jeunesse", "travail"],
    },
    {
      text: "Le bollette della luce sono raddoppiate in due anni.",
      themes: ["pouvoir d'achat", "énergie"],
    },
    {
      text: "Vorrei che i cittadini potessero votare sulle grandi opere del territorio.",
      themes: ["démocratie"],
    },
  ],
  ar: [
    {
      text: "الأسعار ترتفع كل شهر والرواتب لا تتغير. لم نعد نستطيع شراء اللحم إلا في المناسبات.",
      themes: ["pouvoir d'achat"],
    },
    {
      text: "ابني تخرج من الجامعة منذ ثلاث سنوات ولم يجد عملاً حتى الآن.",
      themes: ["jeunesse", "travail", "éducation"],
    },
    { text: "نريد أن يستمع المسؤولون إلينا قبل اتخاذ القرارات، لا بعدها.", themes: ["démocratie"] },
    {
      text: "المستشفى الأقرب يبعد ساعتين، والطريق سيئة في الشتاء.",
      themes: ["santé", "transports"],
    },
  ],
  ja: [
    {
      text: "村には若い人がほとんどいません。学校も来年閉校になります。",
      themes: ["ruralité", "éducation", "jeunesse"],
    },
    {
      text: "物価が上がっているのに、年金は増えません。",
      themes: ["pouvoir d'achat", "retraites"],
    },
    {
      text: "選挙のときだけ政治家が来て、あとは誰も話を聞いてくれません。",
      themes: ["démocratie"],
    },
    { text: "夏の暑さが年々ひどくなっていて、高齢者が心配です。", themes: ["climat", "santé"] },
  ],
  zh: [
    { text: "房租太贵了，我和两个室友住在一间小公寓里。", themes: ["logement", "pouvoir d'achat"] },
    { text: "年轻人工作压力很大，经常加班到晚上十点。", themes: ["travail", "jeunesse"] },
    { text: "希望政府在做决定之前多听听居民的意见。", themes: ["démocratie"] },
    { text: "城市里空气污染很严重，孩子经常咳嗽。", themes: ["écologie", "santé"] },
  ],
  ru: [
    { text: "Цены растут каждый месяц, а зарплата остаётся прежней.", themes: ["pouvoir d'achat"] },
    {
      text: "В нашей деревне закрыли больницу, теперь до врача ехать два часа.",
      themes: ["santé", "ruralité"],
    },
    {
      text: "Молодёжь уезжает в большие города, здесь нет работы.",
      themes: ["jeunesse", "travail", "ruralité"],
    },
    { text: "Хочется, чтобы власть слышала простых людей.", themes: ["démocratie"] },
  ],
  sw: [
    {
      text: "Bei ya chakula imepanda sana, familia nyingi zinakula mara moja tu kwa siku.",
      themes: ["pouvoir d'achat", "solidarité"],
    },
    {
      text: "Hospitali iko mbali na barabara ni mbaya wakati wa mvua.",
      themes: ["santé", "transports"],
    },
    { text: "Vijana wengi hawana kazi baada ya kumaliza shule.", themes: ["jeunesse", "travail"] },
    { text: "Tunataka viongozi watusikilize kabla ya kufanya maamuzi.", themes: ["démocratie"] },
  ],
  tr: [
    {
      text: "Kiralar o kadar arttı ki maaşımın yarısı eve gidiyor.",
      themes: ["logement", "pouvoir d'achat"],
    },
    {
      text: "Gençler iş bulamıyor, çoğu yurt dışına gitmek istiyor.",
      themes: ["jeunesse", "travail"],
    },
    {
      text: "Seçimden seçime hatırlanıyoruz, sonra kimse bizi dinlemiyor.",
      themes: ["démocratie"],
    },
    {
      text: "Depremden sonra binaların güvenliği konusunda çok endişeliyiz.",
      themes: ["sécurité", "logement"],
    },
  ],
  hi: [
    {
      text: "गाँव में अस्पताल नहीं है, इलाज के लिए शहर जाना पड़ता है।",
      themes: ["santé", "ruralité"],
    },
    { text: "महंगाई बहुत बढ़ गई है, घर चलाना मुश्किल हो गया है।", themes: ["pouvoir d'achat"] },
    { text: "नौजवानों के लिए यहाँ कोई काम नहीं है।", themes: ["jeunesse", "travail"] },
    { text: "हम चाहते हैं कि नेता चुनाव के बाद भी हमारी बात सुनें।", themes: ["démocratie"] },
  ],
};

/** First names for testimonies abroad, by the region's naming tradition. */
export const FOREIGN_FIRST_NAMES: Record<string, string[]> = {
  en: ["James", "Mary", "John", "Sarah", "Michael", "Emily", "David", "Grace", "Daniel", "Olivia"],
  es: ["María", "José", "Carmen", "Juan", "Lucía", "Carlos", "Ana", "Luis", "Sofía", "Diego"],
  pt: ["João", "Ana", "Pedro", "Mariana", "Lucas", "Beatriz", "Tiago", "Joana"],
  de: ["Anna", "Lukas", "Lena", "Jonas", "Sophie", "Felix", "Marie", "Paul"],
  it: ["Giulia", "Marco", "Francesca", "Luca", "Chiara", "Matteo"],
  ar: ["Ahmed", "Fatima", "Youssef", "Leila", "Omar", "Amina", "Karim", "Salma"],
  ja: ["Yuki", "Haruto", "Sakura", "Ren", "Aoi", "Hiroshi"],
  zh: ["Wei", "Li Na", "Jun", "Mei", "Hao", "Xiu"],
  ru: ["Ivan", "Olga", "Dmitri", "Natalia", "Sergei", "Anastasia"],
  sw: ["Baraka", "Neema", "Juma", "Amani", "Zawadi", "Hamisi"],
  tr: ["Mehmet", "Ayşe", "Mustafa", "Elif", "Emre", "Zeynep"],
  hi: ["Arjun", "Priya", "Rahul", "Ananya", "Ravi", "Sunita"],
  fr: [
    "Kwame",
    "Ama",
    "Chinedu",
    "Ngozi",
    "Amadou",
    "Aïssatou",
    "Moussa",
    "Fatou",
    "Jean-Baptiste",
    "Mireille",
  ],
};
