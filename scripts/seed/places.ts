// Where the fake auditions happen. Real geography (the map geocodes these
// names), nothing else real: no real audition is reproduced here.

import type { Theme } from "./texts";

export interface FrancePlace {
  /** The audition's `location`, as people typed it on the real site. */
  location: string;
  /** How many auditions were held there. */
  times: number;
}

export interface Cluster {
  name: string;
  /** Audition dates: days before the seed, oldest first. */
  daysAgo: [number, number];
  /** Themes this kind of place talks about more. */
  boost: Partial<Record<Theme, number>>;
  places: FrancePlace[];
}

/** Lyon and its suburbs: markets and squares, several times each — where the
 *  real auditions are held (plus La Tour-du-Pin). */
const LYON: Cluster = {
  name: "lyon",
  daysAgo: [0, 420],
  boost: {
    logement: 3,
    transports: 2,
    "pouvoir d'achat": 2,
    sécurité: 2,
    "vie de quartier": 6,
    immigration: 2,
    écologie: 1.5,
  },
  places: [
    { location: "Marché des Gratte-Ciel, Villeurbanne", times: 5 },
    { location: "Place Grandclément, Villeurbanne", times: 4 },
    { location: "Marché des Charpennes, Villeurbanne", times: 3 },
    { location: "Parvis de la médiathèque, Bron", times: 2 },
    { location: "Marché de la Croix-Rousse, Lyon", times: 2 },
    { location: "Place Jean Macé, Lyon 7", times: 2 },
    { location: "Marché Saint-Antoine, Lyon", times: 2 },
    { location: "Gare Part-Dieu, Lyon", times: 2 },
    { location: "Place Bellecour, Lyon", times: 1 },
    { location: "Place Guichard, Lyon", times: 1 },
    { location: "Marché de Monplaisir, Lyon", times: 1 },
    { location: "Place des Terreaux, Lyon", times: 1 },
    { location: "Parc de la Tête d'Or, Lyon", times: 1 },
    { location: "Place Ferber, Bron", times: 1 },
    { location: "Marché du centre, Vénissieux", times: 1 },
    { location: "Place Lazare Goujon, Villeurbanne", times: 1 },
    { location: "Mas du Taureau, Vaulx-en-Velin", times: 1 },
    { location: "Place Sathonay, Lyon", times: 1 },
    { location: "Quai Saint-Vincent, Lyon", times: 1 },
    { location: "Place Carnot, Lyon", times: 1 },
    { location: "La Tour-du-Pin", times: 4 },
  ],
};

/** Hautes-Alpes villages, typed as bare commune names: the map's rural side. */
const ALPS: Cluster = {
  name: "alps",
  daysAgo: [30, 420],
  boost: {
    ruralité: 3,
    agriculture: 3,
    "services publics": 2,
    transports: 2,
    santé: 1.5,
    climat: 3,
  },
  places: [
    "Embrun",
    "Briançon",
    "Guillestre",
    "Veynes",
    "Saint-Bonnet-en-Champsaur",
    "L'Argentière-la-Bessée",
    "Orpierre",
    "Remollon",
  ].map((location) => ({ location, times: 1 })),
};

/** Elsewhere in France, so the map has to show the whole country. */
const ELSEWHERE: Cluster = {
  name: "elsewhere",
  daysAgo: [20, 420],
  boost: {},
  places: [
    "Place de la République, Paris",
    "Vieux-Port, Marseille",
    "Place du Capitole, Toulouse",
    "Marché de Wazemmes, Lille",
    "Place Kléber, Strasbourg",
    "Place Royale, Nantes",
    "Place Grenette, Grenoble",
    "Place de Jaude, Clermont-Ferrand",
    "Aurillac",
    "Mende",
  ].map((location) => ({ location, times: 1 })),
};

/**
 * Places that test the edges of geocoding: a département instead of a town,
 * overseas towns (outside the map's mainland box), a homonym (Saint-Denis,
 * 93 or Réunion), a very long place name.
 */
const EDGES: Cluster = {
  name: "edges",
  daysAgo: [60, 420],
  boost: {},
  places: [
    "Hautes-Alpes",
    "Ardèche",
    "Fort-de-France",
    "Saint-Pierre, La Réunion",
    "Cayenne",
    "Saint-Denis",
    "Parvis de la Maison des Jeunes et de la Culture du quartier des États-Unis, Lyon 8",
  ].map((location) => ({ location, times: 1 })),
};

export const FRANCE_CLUSTERS: Cluster[] = [LYON, ALPS, ELSEWHERE, EDGES];

/** Online auditions: one per town hall and month (see submit_online_testimony). */
export interface OnlineTownHall {
  location: string;
  citycode: string;
  place: {
    insee: string;
    commune: string;
    arrondissement: string | null;
    departementCode: string;
    departementName: string;
    region: string;
    lat: number;
    lng: number;
  };
}

export const ONLINE_TOWN_HALLS: OnlineTownHall[] = [
  {
    location: "Mairie de Villeurbanne (69)",
    citycode: "69266",
    place: {
      insee: "69266",
      commune: "Villeurbanne",
      arrondissement: null,
      departementCode: "69",
      departementName: "Rhône",
      region: "Auvergne-Rhône-Alpes",
      lat: 45.7667,
      lng: 4.8803,
    },
  },
  {
    location: "Mairie du 7e arrondissement de Lyon",
    citycode: "69387",
    place: {
      insee: "69387",
      commune: "Lyon",
      arrondissement: "Lyon 7e",
      departementCode: "69",
      departementName: "Rhône",
      region: "Auvergne-Rhône-Alpes",
      lat: 45.7457,
      lng: 4.8424,
    },
  },
  {
    location: "Mairie de Grenoble (38)",
    citycode: "38185",
    place: {
      insee: "38185",
      commune: "Grenoble",
      arrondissement: null,
      departementCode: "38",
      departementName: "Isère",
      region: "Auvergne-Rhône-Alpes",
      lat: 45.1885,
      lng: 5.7245,
    },
  },
  {
    location: "Mairie de Gap (05)",
    citycode: "05061",
    place: {
      insee: "05061",
      commune: "Gap",
      arrondissement: null,
      departementCode: "05",
      departementName: "Hautes-Alpes",
      region: "Provence-Alpes-Côte d'Azur",
      lat: 44.5594,
      lng: 6.0786,
    },
  },
];

/** Every country but France (the `france` profile covers it), in French,
 *  with a few of its cities and the language its testimonies may be in. */
export const COUNTRIES: { country: string; lang: string; cities: string[] }[] = [
  // Afrique
  { country: "Afrique du Sud", lang: "en", cities: ["Johannesburg", "Le Cap", "Durban"] },
  { country: "Algérie", lang: "ar", cities: ["Alger", "Oran", "Constantine"] },
  { country: "Angola", lang: "pt", cities: ["Luanda", "Huambo", "Lobito"] },
  { country: "Bénin", lang: "fr", cities: ["Cotonou", "Porto-Novo", "Parakou"] },
  { country: "Botswana", lang: "en", cities: ["Gaborone", "Francistown"] },
  { country: "Burkina Faso", lang: "fr", cities: ["Ouagadougou", "Bobo-Dioulasso", "Koudougou"] },
  { country: "Burundi", lang: "fr", cities: ["Gitega", "Bujumbura"] },
  { country: "Cap-Vert", lang: "pt", cities: ["Praia", "Mindelo"] },
  { country: "Cameroun", lang: "fr", cities: ["Douala", "Yaoundé", "Garoua"] },
  { country: "Centrafrique", lang: "fr", cities: ["Bangui", "Bimbo"] },
  { country: "Comores", lang: "fr", cities: ["Moroni", "Mutsamudu"] },
  { country: "Congo", lang: "fr", cities: ["Brazzaville", "Pointe-Noire"] },
  {
    country: "République démocratique du Congo",
    lang: "fr",
    cities: ["Kinshasa", "Lubumbashi", "Goma"],
  },
  { country: "Côte d'Ivoire", lang: "fr", cities: ["Abidjan", "Bouaké", "Yamoussoukro"] },
  { country: "Djibouti", lang: "fr", cities: ["Djibouti", "Ali Sabieh"] },
  { country: "Égypte", lang: "ar", cities: ["Le Caire", "Alexandrie", "Assouan"] },
  { country: "Érythrée", lang: "ar", cities: ["Asmara", "Massaoua"] },
  { country: "Eswatini", lang: "en", cities: ["Mbabane", "Manzini"] },
  { country: "Éthiopie", lang: "en", cities: ["Addis-Abeba", "Dire Dawa", "Bahir Dar"] },
  { country: "Gabon", lang: "fr", cities: ["Libreville", "Port-Gentil"] },
  { country: "Gambie", lang: "en", cities: ["Banjul", "Serekunda"] },
  { country: "Ghana", lang: "en", cities: ["Accra", "Kumasi", "Tamale"] },
  { country: "Guinée", lang: "fr", cities: ["Conakry", "Kankan", "Labé"] },
  { country: "Guinée-Bissau", lang: "pt", cities: ["Bissau", "Bafatá"] },
  { country: "Guinée équatoriale", lang: "es", cities: ["Malabo", "Bata"] },
  { country: "Kenya", lang: "sw", cities: ["Nairobi", "Mombasa", "Kisumu"] },
  { country: "Lesotho", lang: "en", cities: ["Maseru", "Teyateyaneng"] },
  { country: "Liberia", lang: "en", cities: ["Monrovia", "Gbarnga"] },
  { country: "Libye", lang: "ar", cities: ["Tripoli", "Benghazi", "Misrata"] },
  { country: "Madagascar", lang: "fr", cities: ["Antananarivo", "Toamasina", "Fianarantsoa"] },
  { country: "Malawi", lang: "en", cities: ["Lilongwe", "Blantyre"] },
  { country: "Mali", lang: "fr", cities: ["Bamako", "Sikasso", "Mopti"] },
  { country: "Maroc", lang: "ar", cities: ["Casablanca", "Rabat", "Marrakech", "Fès"] },
  { country: "Maurice", lang: "fr", cities: ["Port-Louis", "Curepipe"] },
  { country: "Mauritanie", lang: "ar", cities: ["Nouakchott", "Nouadhibou"] },
  { country: "Mozambique", lang: "pt", cities: ["Maputo", "Beira", "Nampula"] },
  { country: "Namibie", lang: "en", cities: ["Windhoek", "Walvis Bay"] },
  { country: "Niger", lang: "fr", cities: ["Niamey", "Zinder", "Maradi"] },
  { country: "Nigeria", lang: "en", cities: ["Lagos", "Abuja", "Kano", "Ibadan"] },
  { country: "Ouganda", lang: "sw", cities: ["Kampala", "Gulu", "Mbarara"] },
  { country: "Rwanda", lang: "fr", cities: ["Kigali", "Huye"] },
  { country: "Sao Tomé-et-Principe", lang: "pt", cities: ["São Tomé", "Santo António"] },
  { country: "Sénégal", lang: "fr", cities: ["Dakar", "Saint-Louis", "Thiès", "Ziguinchor"] },
  { country: "Seychelles", lang: "fr", cities: ["Victoria", "Anse Boileau"] },
  { country: "Sierra Leone", lang: "en", cities: ["Freetown", "Bo"] },
  { country: "Somalie", lang: "ar", cities: ["Mogadiscio", "Hargeisa"] },
  { country: "Soudan", lang: "ar", cities: ["Khartoum", "Omdurman", "Port-Soudan"] },
  { country: "Soudan du Sud", lang: "en", cities: ["Djouba", "Wau"] },
  { country: "Tanzanie", lang: "sw", cities: ["Dar es Salaam", "Dodoma", "Arusha"] },
  { country: "Tchad", lang: "fr", cities: ["N'Djaména", "Moundou"] },
  { country: "Togo", lang: "fr", cities: ["Lomé", "Sokodé", "Kara"] },
  { country: "Tunisie", lang: "ar", cities: ["Tunis", "Sfax", "Sousse"] },
  { country: "Zambie", lang: "en", cities: ["Lusaka", "Ndola"] },
  { country: "Zimbabwe", lang: "en", cities: ["Harare", "Bulawayo"] },
  // Amériques
  { country: "Antigua-et-Barbuda", lang: "en", cities: ["Saint John's", "All Saints"] },
  { country: "Argentine", lang: "es", cities: ["Buenos Aires", "Córdoba", "Rosario", "Mendoza"] },
  { country: "Bahamas", lang: "en", cities: ["Nassau", "Freeport"] },
  { country: "Barbade", lang: "en", cities: ["Bridgetown", "Speightstown"] },
  { country: "Belize", lang: "en", cities: ["Belmopan", "Belize City"] },
  { country: "Bolivie", lang: "es", cities: ["La Paz", "Santa Cruz de la Sierra", "Cochabamba"] },
  {
    country: "Brésil",
    lang: "pt",
    cities: ["São Paulo", "Rio de Janeiro", "Salvador", "Recife", "Belém"],
  },
  { country: "Canada", lang: "fr", cities: ["Montréal", "Toronto", "Vancouver", "Québec"] },
  { country: "Chili", lang: "es", cities: ["Santiago", "Valparaíso", "Concepción"] },
  { country: "Colombie", lang: "es", cities: ["Bogota", "Medellín", "Cali"] },
  { country: "Costa Rica", lang: "es", cities: ["San José", "Limón"] },
  { country: "Cuba", lang: "es", cities: ["La Havane", "Santiago de Cuba"] },
  { country: "Dominique", lang: "en", cities: ["Roseau", "Portsmouth"] },
  { country: "Équateur", lang: "es", cities: ["Quito", "Guayaquil", "Cuenca"] },
  { country: "États-Unis", lang: "en", cities: ["New York", "Chicago", "Los Angeles", "Atlanta"] },
  { country: "Grenade", lang: "en", cities: ["Saint-Georges", "Gouyave"] },
  { country: "Guatemala", lang: "es", cities: ["Guatemala", "Quetzaltenango"] },
  { country: "Guyana", lang: "en", cities: ["Georgetown", "Linden"] },
  { country: "Haïti", lang: "fr", cities: ["Port-au-Prince", "Cap-Haïtien", "Les Cayes"] },
  { country: "Honduras", lang: "es", cities: ["Tegucigalpa", "San Pedro Sula"] },
  { country: "Jamaïque", lang: "en", cities: ["Kingston", "Montego Bay"] },
  { country: "Mexique", lang: "es", cities: ["Mexico", "Guadalajara", "Monterrey", "Oaxaca"] },
  { country: "Nicaragua", lang: "es", cities: ["Managua", "León"] },
  { country: "Panama", lang: "es", cities: ["Panama", "Colón"] },
  { country: "Paraguay", lang: "es", cities: ["Asunción", "Ciudad del Este"] },
  { country: "Pérou", lang: "es", cities: ["Lima", "Arequipa", "Cuzco"] },
  {
    country: "République dominicaine",
    lang: "es",
    cities: ["Saint-Domingue", "Santiago de los Caballeros"],
  },
  { country: "Saint-Christophe-et-Niévès", lang: "en", cities: ["Basseterre", "Charlestown"] },
  { country: "Sainte-Lucie", lang: "en", cities: ["Castries", "Vieux Fort"] },
  { country: "Saint-Vincent-et-les-Grenadines", lang: "en", cities: ["Kingstown", "Georgetown"] },
  { country: "Salvador", lang: "es", cities: ["San Salvador", "Santa Ana"] },
  { country: "Suriname", lang: "en", cities: ["Paramaribo", "Lelydorp"] },
  { country: "Trinité-et-Tobago", lang: "en", cities: ["Port-d'Espagne", "San Fernando"] },
  { country: "Uruguay", lang: "es", cities: ["Montevideo", "Salto"] },
  { country: "Venezuela", lang: "es", cities: ["Caracas", "Maracaibo", "Valencia"] },
  // Asie
  { country: "Afghanistan", lang: "fr", cities: ["Kaboul", "Hérat", "Mazar-e Charif"] },
  { country: "Arabie saoudite", lang: "ar", cities: ["Riyad", "Djeddah", "Dammam"] },
  { country: "Arménie", lang: "ru", cities: ["Erevan", "Gyumri"] },
  { country: "Azerbaïdjan", lang: "ru", cities: ["Bakou", "Gandja"] },
  { country: "Bahreïn", lang: "ar", cities: ["Manama", "Muharraq"] },
  { country: "Bangladesh", lang: "en", cities: ["Dacca", "Chittagong", "Khulna"] },
  { country: "Bhoutan", lang: "en", cities: ["Thimphou", "Phuntsholing"] },
  { country: "Birmanie", lang: "en", cities: ["Rangoun", "Mandalay", "Naypyidaw"] },
  { country: "Brunei", lang: "en", cities: ["Bandar Seri Begawan", "Kuala Belait"] },
  { country: "Cambodge", lang: "fr", cities: ["Phnom Penh", "Siem Reap", "Battambang"] },
  { country: "Chine", lang: "zh", cities: ["Pékin", "Shanghai", "Canton", "Chengdu", "Wuhan"] },
  { country: "Corée du Nord", lang: "en", cities: ["Pyongyang", "Hamhung"] },
  { country: "Corée du Sud", lang: "en", cities: ["Séoul", "Busan", "Daegu"] },
  { country: "Émirats arabes unis", lang: "ar", cities: ["Dubaï", "Abou Dabi", "Charjah"] },
  { country: "Géorgie", lang: "ru", cities: ["Tbilissi", "Batoumi", "Koutaïssi"] },
  {
    country: "Inde",
    lang: "hi",
    cities: ["New Delhi", "Bombay", "Bangalore", "Calcutta", "Chennai"],
  },
  { country: "Indonésie", lang: "en", cities: ["Jakarta", "Surabaya", "Bandung", "Medan"] },
  { country: "Irak", lang: "ar", cities: ["Bagdad", "Bassora", "Erbil"] },
  { country: "Iran", lang: "en", cities: ["Téhéran", "Ispahan", "Mashhad", "Tabriz"] },
  { country: "Israël", lang: "en", cities: ["Jérusalem", "Tel Aviv", "Haïfa"] },
  { country: "Japon", lang: "ja", cities: ["Tokyo", "Osaka", "Kyoto", "Sapporo"] },
  { country: "Jordanie", lang: "ar", cities: ["Amman", "Zarqa", "Irbid"] },
  { country: "Kazakhstan", lang: "ru", cities: ["Almaty", "Astana", "Chymkent"] },
  { country: "Kirghizistan", lang: "ru", cities: ["Bichkek", "Och"] },
  { country: "Koweït", lang: "ar", cities: ["Koweït", "Al Jahra"] },
  { country: "Laos", lang: "fr", cities: ["Vientiane", "Luang Prabang"] },
  { country: "Liban", lang: "ar", cities: ["Beyrouth", "Tripoli", "Saïda"] },
  { country: "Malaisie", lang: "en", cities: ["Kuala Lumpur", "George Town", "Johor Bahru"] },
  { country: "Maldives", lang: "en", cities: ["Malé", "Addu"] },
  { country: "Mongolie", lang: "ru", cities: ["Oulan-Bator", "Erdenet"] },
  { country: "Népal", lang: "hi", cities: ["Katmandou", "Pokhara"] },
  { country: "Oman", lang: "ar", cities: ["Mascate", "Salalah"] },
  { country: "Ouzbékistan", lang: "ru", cities: ["Tachkent", "Samarcande", "Boukhara"] },
  { country: "Pakistan", lang: "en", cities: ["Karachi", "Lahore", "Islamabad"] },
  { country: "Palestine", lang: "ar", cities: ["Ramallah", "Gaza", "Naplouse"] },
  { country: "Philippines", lang: "en", cities: ["Manille", "Cebu", "Davao"] },
  { country: "Qatar", lang: "ar", cities: ["Doha", "Al Rayyan"] },
  { country: "Singapour", lang: "zh", cities: ["Singapour", "Jurong"] },
  { country: "Sri Lanka", lang: "en", cities: ["Colombo", "Kandy", "Jaffna"] },
  { country: "Syrie", lang: "ar", cities: ["Damas", "Alep", "Homs"] },
  { country: "Tadjikistan", lang: "ru", cities: ["Douchanbé", "Khodjent"] },
  { country: "Taïwan", lang: "zh", cities: ["Taipei", "Kaohsiung", "Taichung"] },
  { country: "Thaïlande", lang: "en", cities: ["Bangkok", "Chiang Mai", "Phuket"] },
  { country: "Timor oriental", lang: "pt", cities: ["Dili", "Baucau"] },
  { country: "Turkménistan", lang: "ru", cities: ["Achgabat", "Turkmenabat"] },
  { country: "Turquie", lang: "tr", cities: ["Istanbul", "Ankara", "Izmir", "Diyarbakır"] },
  { country: "Viêt Nam", lang: "fr", cities: ["Hanoï", "Hô Chi Minh-Ville", "Da Nang"] },
  { country: "Yémen", lang: "ar", cities: ["Sanaa", "Aden", "Taëz"] },
  // Europe
  { country: "Albanie", lang: "it", cities: ["Tirana", "Durrës", "Shkodër"] },
  {
    country: "Allemagne",
    lang: "de",
    cities: ["Berlin", "Hambourg", "Munich", "Cologne", "Leipzig"],
  },
  { country: "Andorre", lang: "es", cities: ["Andorre-la-Vieille", "Escaldes-Engordany"] },
  { country: "Autriche", lang: "de", cities: ["Vienne", "Graz", "Linz"] },
  { country: "Belgique", lang: "fr", cities: ["Bruxelles", "Liège", "Anvers", "Charleroi"] },
  { country: "Biélorussie", lang: "ru", cities: ["Minsk", "Gomel"] },
  { country: "Bosnie-Herzégovine", lang: "en", cities: ["Sarajevo", "Banja Luka", "Mostar"] },
  { country: "Bulgarie", lang: "ru", cities: ["Sofia", "Plovdiv", "Varna"] },
  { country: "Chypre", lang: "en", cities: ["Nicosie", "Limassol"] },
  { country: "Croatie", lang: "de", cities: ["Zagreb", "Split", "Rijeka"] },
  { country: "Danemark", lang: "en", cities: ["Copenhague", "Aarhus", "Odense"] },
  {
    country: "Espagne",
    lang: "es",
    cities: ["Madrid", "Barcelone", "Séville", "Bilbao", "Valence"],
  },
  { country: "Estonie", lang: "en", cities: ["Tallinn", "Tartu"] },
  { country: "Finlande", lang: "en", cities: ["Helsinki", "Tampere", "Oulu"] },
  { country: "Grèce", lang: "en", cities: ["Athènes", "Thessalonique", "Héraklion"] },
  { country: "Hongrie", lang: "de", cities: ["Budapest", "Debrecen", "Szeged"] },
  { country: "Irlande", lang: "en", cities: ["Dublin", "Cork", "Galway"] },
  { country: "Islande", lang: "en", cities: ["Reykjavik", "Akureyri"] },
  { country: "Italie", lang: "it", cities: ["Rome", "Milan", "Naples", "Turin", "Palerme"] },
  { country: "Kosovo", lang: "en", cities: ["Pristina", "Prizren"] },
  { country: "Lettonie", lang: "ru", cities: ["Riga", "Daugavpils"] },
  { country: "Liechtenstein", lang: "de", cities: ["Vaduz", "Schaan"] },
  { country: "Lituanie", lang: "en", cities: ["Vilnius", "Kaunas"] },
  { country: "Luxembourg", lang: "fr", cities: ["Luxembourg", "Esch-sur-Alzette"] },
  { country: "Macédoine du Nord", lang: "en", cities: ["Skopje", "Bitola"] },
  { country: "Malte", lang: "en", cities: ["La Valette", "Birkirkara"] },
  { country: "Moldavie", lang: "ru", cities: ["Chișinău", "Bălți"] },
  { country: "Monaco", lang: "fr", cities: ["Monaco", "Monte-Carlo"] },
  { country: "Monténégro", lang: "en", cities: ["Podgorica", "Nikšić"] },
  { country: "Norvège", lang: "en", cities: ["Oslo", "Bergen", "Trondheim"] },
  { country: "Pays-Bas", lang: "en", cities: ["Amsterdam", "Rotterdam", "Utrecht"] },
  { country: "Pologne", lang: "en", cities: ["Varsovie", "Cracovie", "Gdańsk", "Wrocław"] },
  { country: "Portugal", lang: "pt", cities: ["Lisbonne", "Porto", "Coimbra"] },
  { country: "Roumanie", lang: "fr", cities: ["Bucarest", "Cluj-Napoca", "Iași"] },
  { country: "Royaume-Uni", lang: "en", cities: ["Londres", "Manchester", "Glasgow", "Belfast"] },
  {
    country: "Russie",
    lang: "ru",
    cities: ["Moscou", "Saint-Pétersbourg", "Novossibirsk", "Kazan"],
  },
  { country: "Saint-Marin", lang: "it", cities: ["Saint-Marin", "Serravalle"] },
  { country: "Serbie", lang: "ru", cities: ["Belgrade", "Novi Sad", "Niš"] },
  { country: "Slovaquie", lang: "de", cities: ["Bratislava", "Košice"] },
  { country: "Slovénie", lang: "de", cities: ["Ljubljana", "Maribor"] },
  { country: "Suède", lang: "en", cities: ["Stockholm", "Göteborg", "Malmö"] },
  { country: "Suisse", lang: "fr", cities: ["Genève", "Lausanne", "Zurich", "Berne"] },
  { country: "Tchéquie", lang: "de", cities: ["Prague", "Brno", "Ostrava"] },
  { country: "Ukraine", lang: "ru", cities: ["Kyiv", "Lviv", "Odessa", "Kharkiv"] },
  { country: "Vatican", lang: "it", cities: ["Cité du Vatican"] },
  // Océanie
  { country: "Australie", lang: "en", cities: ["Sydney", "Melbourne", "Brisbane", "Perth"] },
  { country: "Fidji", lang: "en", cities: ["Suva", "Lautoka"] },
  { country: "Kiribati", lang: "en", cities: ["Tarawa-Sud", "Betio"] },
  { country: "Îles Marshall", lang: "en", cities: ["Majuro", "Ebeye"] },
  { country: "Micronésie", lang: "en", cities: ["Palikir", "Weno"] },
  { country: "Nauru", lang: "en", cities: ["Yaren", "Denigomodu"] },
  { country: "Nouvelle-Zélande", lang: "en", cities: ["Auckland", "Wellington", "Christchurch"] },
  { country: "Palaos", lang: "en", cities: ["Ngerulmud", "Koror"] },
  { country: "Papouasie-Nouvelle-Guinée", lang: "en", cities: ["Port Moresby", "Lae"] },
  { country: "Îles Salomon", lang: "en", cities: ["Honiara", "Gizo"] },
  { country: "Samoa", lang: "en", cities: ["Apia", "Salelologa"] },
  { country: "Tonga", lang: "en", cities: ["Nukuʻalofa", "Neiafu"] },
  { country: "Tuvalu", lang: "en", cities: ["Funafuti", "Vaitupu"] },
  { country: "Vanuatu", lang: "fr", cities: ["Port-Vila", "Luganville"] },
];
