// The `france-abroad` profile's places outside France (generate.ts): real
// public places (squares, markets, parks) of real cities, written by hand and
// committed, so the seed and CI need no network. Each one is placed as a
// world gazetteer would place it: a country unit, then a locality unit (two
// levels), on the place's own point.
//
// The locality ids are made up here (localityId), not Overture's: this data
// is for the local stack and staging only.

import { createHash } from "node:crypto";
import { normalizeLocation } from "@ac/shared";

/** The Overture release of outline build o20261101-2 (its manifest): the units' and the rows' geo_release. */
export const ABROAD_GEO_RELEASE = "2026-10-21.0";

/**
 * Each country's box [west, south, east, north], copied from the `parent:
 * null` rows of the map's outline index (build o20261101-2, root.json): a
 * country seeded here has an outline there, and its points must lie in its
 * box (abroad.test.ts).
 */
export const OUTLINE_BOXES: Record<string, [number, number, number, number]> = {
  BE: [2.54554, 49.49706, 6.40809, 51.50511],
  CH: [5.9559, 45.81797, 10.49206, 47.80845],
  BJ: [0.77667, 6.23601, 3.84515, 12.4092],
  SN: [-17.53163, 12.31443, -11.34601, 16.6919],
  CI: [-8.60147, 4.36234, -2.49294, 10.7402],
  CM: [8.49867, 1.65179, 16.19055, 13.08333],
  MG: [43.18709, -25.60569, 50.48605, -11.95275],
  DE: [5.86632, 47.27025, 15.04193, 55.05854],
  ES: [-18.15676, 27.63774, 4.32803, 43.79035],
  IT: [6.62732, 35.493, 18.51884, 47.09215],
  PT: [-31.26882, 30.13914, -6.18916, 42.15431],
  GB: [-8.65001, 49.88318, 1.7632, 60.84395],
  NL: [3.35838, 50.75037, 7.2275, 53.55349],
  GR: [19.37431, 34.80157, 29.6452, 41.74885],
  TR: [25.66545, 35.80595, 44.81709, 42.1048],
  BR: [-73.98306, -33.75117, -29.29947, 5.26891],
  AR: [-73.56052, -55.05783, -53.63745, -21.78086],
  MX: [-118.36506, 14.53149, -86.71075, 32.71871],
  CO: [-81.73246, -4.22809, -66.85118, 15.7977],
  JP: [122.93365, 24.04562, 153.98608, 45.52294],
  IN: [68.48448, 6.75724, 97.39462, 35.67285],
  VN: [102.14386, 8.41313, 109.46161, 23.39267],
  AU: [112.921, -54.77693, 159.10416, -9.21969],
  KE: [33.9106, -4.74065, 41.90675, 5.02306],
  MA: [-17.10463, 20.7701, -0.99944, 35.92245],
  TN: [7.52198, 30.22906, 11.59994, 37.54203],
};

/** A public place of a city: its name as people say it, and its own point. */
export interface AbroadSpot {
  name: string;
  lat: number;
  lng: number;
}

export interface AbroadCity {
  /** In French where French has a name: the locality unit's name. */
  name: string;
  /** The city centre: the locality unit's point. */
  lat: number;
  lng: number;
  spots: AbroadSpot[];
}

export interface AbroadCountry {
  /** ISO 3166-1 alpha-2: the country unit's id. */
  iso: string;
  /** In French, spelled as places.ts COUNTRIES spells it. */
  name: string;
  /** "fr", or the language some of its testimonies are in (a key of texts.ts FOREIGN), as in COUNTRIES. */
  lang: string;
  cities: AbroadCity[];
}

const city = (
  name: string,
  lat: number,
  lng: number,
  ...spots: [name: string, lat: number, lng: number][]
): AbroadCity => ({
  name,
  lat,
  lng,
  spots: spots.map(([spot, spotLat, spotLng]) => ({ name: spot, lat: spotLat, lng: spotLng })),
});

export const ABROAD: AbroadCountry[] = [
  // Europe
  {
    iso: "BE",
    name: "Belgique",
    lang: "fr",
    cities: [
      city(
        "Bruxelles",
        50.8503,
        4.3517,
        ["Grand-Place", 50.8467, 4.3524],
        ["Place Flagey", 50.8277, 4.3723],
      ),
      city(
        "Liège",
        50.6326,
        5.5797,
        ["Place Saint-Lambert", 50.6455, 5.5738],
        ["Marché de la Batte", 50.6472, 5.5786],
      ),
    ],
  },
  {
    iso: "CH",
    name: "Suisse",
    lang: "fr",
    cities: [
      city(
        "Genève",
        46.2044,
        6.1432,
        ["Plaine de Plainpalais", 46.1982, 6.1408],
        ["Place du Molard", 46.2031, 6.1477],
      ),
      city(
        "Lausanne",
        46.5197,
        6.6323,
        ["Place de la Palud", 46.5219, 6.6329],
        ["Place de la Riponne", 46.5237, 6.6333],
      ),
    ],
  },
  {
    iso: "DE",
    name: "Allemagne",
    lang: "de",
    cities: [
      city(
        "Berlin",
        52.52,
        13.405,
        ["Alexanderplatz", 52.5219, 13.4132],
        ["Porte de Brandebourg", 52.5163, 13.3777],
      ),
      city(
        "Munich",
        48.1372,
        11.5756,
        ["Marienplatz", 48.1374, 11.5755],
        ["Viktualienmarkt", 48.1351, 11.5763],
      ),
      city(
        "Hambourg",
        53.5511,
        9.9937,
        ["Rathausmarkt", 53.5505, 9.9925],
        ["Planten un Blomen", 53.5607, 9.9822],
      ),
    ],
  },
  {
    iso: "ES",
    name: "Espagne",
    lang: "es",
    cities: [
      city(
        "Madrid",
        40.4168,
        -3.7038,
        ["Puerta del Sol", 40.4169, -3.7035],
        ["Plaza Mayor", 40.4155, -3.7074],
      ),
      city(
        "Séville",
        37.3891,
        -5.9845,
        ["Plaza de España", 37.3772, -5.9869],
        ["Plaza Nueva", 37.3886, -5.9953],
      ),
    ],
  },
  {
    iso: "IT",
    name: "Italie",
    lang: "it",
    cities: [
      city(
        "Rome",
        41.9028,
        12.4964,
        ["Piazza Navona", 41.8992, 12.4731],
        ["Campo de' Fiori", 41.8956, 12.4722],
      ),
      city(
        "Naples",
        40.8518,
        14.2681,
        ["Piazza del Plebiscito", 40.8359, 14.2487],
        ["Piazza Dante", 40.849, 14.25],
      ),
    ],
  },
  {
    iso: "PT",
    name: "Portugal",
    lang: "pt",
    cities: [
      city(
        "Lisbonne",
        38.7223,
        -9.1393,
        ["Place du Commerce", 38.7075, -9.1364],
        ["Place du Rossio", 38.7139, -9.1394],
      ),
      city(
        "Porto",
        41.1579,
        -8.6291,
        ["Avenida dos Aliados", 41.1487, -8.611],
        ["Marché du Bolhão", 41.1494, -8.6072],
      ),
    ],
  },
  {
    iso: "GB",
    name: "Royaume-Uni",
    lang: "en",
    cities: [
      city(
        "Londres",
        51.5074,
        -0.1278,
        ["Trafalgar Square", 51.508, -0.1281],
        ["Borough Market", 51.5055, -0.091],
      ),
      city(
        "Manchester",
        53.4808,
        -2.2426,
        ["Albert Square", 53.4794, -2.2446],
        ["Piccadilly Gardens", 53.481, -2.2369],
      ),
      city(
        "Glasgow",
        55.8642,
        -4.2518,
        ["George Square", 55.8612, -4.2501],
        ["Glasgow Green", 55.849, -4.235],
      ),
    ],
  },
  {
    iso: "NL",
    name: "Pays-Bas",
    lang: "en",
    cities: [
      city(
        "Amsterdam",
        52.3676,
        4.9041,
        ["Place du Dam", 52.3731, 4.8926],
        ["Vondelpark", 52.358, 4.8686],
      ),
      city(
        "Rotterdam",
        51.9244,
        4.4777,
        ["Marché de Binnenrotte", 51.9213, 4.4878],
        ["Schouwburgplein", 51.9208, 4.4735],
      ),
    ],
  },
  {
    iso: "GR",
    name: "Grèce",
    lang: "en",
    cities: [
      city(
        "Athènes",
        37.9838,
        23.7275,
        ["Place Syntagma", 37.9755, 23.7348],
        ["Place Monastiraki", 37.9763, 23.7257],
      ),
      city(
        "Thessalonique",
        40.6401,
        22.9444,
        ["Place Aristote", 40.6325, 22.9408],
        ["Tour Blanche", 40.6264, 22.9484],
      ),
    ],
  },
  {
    iso: "TR",
    name: "Turquie",
    lang: "tr",
    cities: [
      city(
        "Istanbul",
        41.0082,
        28.9784,
        ["Place Taksim", 41.037, 28.985],
        ["Place Sultanahmet", 41.006, 28.9768],
      ),
      city(
        "Ankara",
        39.9334,
        32.8597,
        ["Place Kızılay", 39.9208, 32.8541],
        ["Parc Gençlik", 39.937, 32.849],
      ),
    ],
  },
  // Afrique
  {
    iso: "MA",
    name: "Maroc",
    lang: "ar",
    cities: [
      city(
        "Casablanca",
        33.5731,
        -7.5898,
        ["Place Mohammed V", 33.5912, -7.619],
        ["Place des Nations-Unies", 33.595, -7.6187],
      ),
      city(
        "Marrakech",
        31.6295,
        -7.9811,
        ["Place Jemaa el-Fna", 31.6258, -7.9891],
        ["Jardins de la Ménara", 31.6135, -8.022],
      ),
    ],
  },
  {
    iso: "TN",
    name: "Tunisie",
    lang: "ar",
    cities: [
      city(
        "Tunis",
        36.8065,
        10.1815,
        ["Avenue Habib-Bourguiba", 36.8, 10.181],
        ["Place de la Kasbah", 36.7988, 10.1675],
        ["Parc du Belvédère", 36.821, 10.1735],
      ),
    ],
  },
  {
    iso: "SN",
    name: "Sénégal",
    lang: "fr",
    cities: [
      city(
        "Dakar",
        14.6928,
        -17.4467,
        ["Place de l'Indépendance", 14.6692, -17.4327],
        ["Marché Sandaga", 14.6723, -17.4385],
        ["Marché Kermel", 14.6702, -17.4288],
      ),
    ],
  },
  {
    iso: "CI",
    name: "Côte d'Ivoire",
    lang: "fr",
    cities: [
      city(
        "Abidjan",
        5.3364,
        -4.0267,
        ["Place de la République", 5.3178, -4.0197],
        ["Marché de Treichville", 5.3045, -4.007],
        ["Marché de Cocody", 5.3485, -3.998],
      ),
    ],
  },
  {
    iso: "BJ",
    name: "Bénin",
    lang: "fr",
    cities: [
      city(
        "Cotonou",
        6.3654,
        2.4183,
        ["Marché Dantokpa", 6.3714, 2.434],
        ["Place de l'Étoile Rouge", 6.372, 2.4088],
      ),
    ],
  },
  {
    iso: "CM",
    name: "Cameroun",
    lang: "fr",
    cities: [
      city(
        "Yaoundé",
        3.848,
        11.5021,
        ["Marché Central", 3.8655, 11.5178],
        ["Marché Mokolo", 3.8748, 11.5005],
      ),
      city(
        "Douala",
        4.0483,
        9.7043,
        ["Place du Gouvernement", 4.0427, 9.6883],
        ["Marché Central", 4.0425, 9.7062],
      ),
    ],
  },
  {
    iso: "KE",
    name: "Kenya",
    lang: "sw",
    cities: [
      city(
        "Nairobi",
        -1.2921,
        36.8219,
        ["Uhuru Park", -1.2897, 36.8168],
        ["Jeevanjee Gardens", -1.2812, 36.8197],
        ["City Market", -1.2836, 36.8192],
      ),
    ],
  },
  {
    iso: "MG",
    name: "Madagascar",
    lang: "fr",
    cities: [
      city(
        "Antananarivo",
        -18.91,
        47.5255,
        ["Marché d'Analakely", -18.9072, 47.5262],
        ["Lac Anosy", -18.9163, 47.5195],
        ["Place du 13-Mai", -18.9081, 47.5248],
      ),
    ],
  },
  // Amériques
  {
    iso: "BR",
    name: "Brésil",
    lang: "pt",
    cities: [
      city(
        "São Paulo",
        -23.5505,
        -46.6333,
        ["Praça da Sé", -23.5503, -46.6339],
        ["Parc d'Ibirapuera", -23.5874, -46.6576],
      ),
      city(
        "Rio de Janeiro",
        -22.9068,
        -43.1729,
        ["Cinelândia", -22.91, -43.1757],
        ["Largo da Carioca", -22.907, -43.1777],
      ),
      city(
        "Salvador",
        -12.9777,
        -38.5016,
        ["Largo do Pelourinho", -12.9714, -38.509],
        ["Mercado Modelo", -12.973, -38.5135],
      ),
    ],
  },
  {
    iso: "AR",
    name: "Argentine",
    lang: "es",
    cities: [
      city(
        "Buenos Aires",
        -34.6037,
        -58.3816,
        ["Plaza de Mayo", -34.6083, -58.3712],
        ["Plaza San Martín", -34.5955, -58.376],
      ),
      city(
        "Córdoba",
        -31.4201,
        -64.1888,
        ["Plaza San Martín", -31.4167, -64.1835],
        ["Paseo del Buen Pastor", -31.424, -64.187],
      ),
    ],
  },
  {
    iso: "MX",
    name: "Mexique",
    lang: "es",
    cities: [
      city(
        "Mexico",
        19.4326,
        -99.1332,
        ["Zócalo", 19.4326, -99.1332],
        ["Alameda Central", 19.436, -99.144],
      ),
      city(
        "Guadalajara",
        20.6597,
        -103.3496,
        ["Plaza de Armas", 20.6767, -103.3475],
        ["Mercado San Juan de Dios", 20.6752, -103.34],
      ),
    ],
  },
  {
    iso: "CO",
    name: "Colombie",
    lang: "es",
    cities: [
      city(
        "Bogota",
        4.6097,
        -74.0817,
        ["Plaza de Bolívar", 4.5981, -74.076],
        ["Parc Simón Bolívar", 4.658, -74.0937],
      ),
      city(
        "Medellín",
        6.2442,
        -75.5812,
        ["Plaza Botero", 6.2524, -75.5686],
        ["Parque Lleras", 6.2087, -75.5673],
      ),
    ],
  },
  // Asie
  {
    iso: "JP",
    name: "Japon",
    lang: "ja",
    cities: [
      city(
        "Tokyo",
        35.6895,
        139.6917,
        ["Parc Yoyogi", 35.6717, 139.6949],
        ["Parc d'Ueno", 35.7148, 139.7745],
      ),
      city(
        "Osaka",
        34.6937,
        135.5023,
        ["Parc du château d'Osaka", 34.6873, 135.5262],
        ["Parc Nakanoshima", 34.6925, 135.509],
      ),
      city(
        "Kyoto",
        35.0116,
        135.7681,
        ["Marché Nishiki", 35.005, 135.7649],
        ["Parc Maruyama", 35.0038, 135.781],
      ),
    ],
  },
  {
    iso: "IN",
    name: "Inde",
    lang: "hi",
    cities: [
      city(
        "New Delhi",
        28.6139,
        77.209,
        ["Connaught Place", 28.6315, 77.2167],
        ["India Gate", 28.6129, 77.2295],
      ),
      city(
        "Bombay",
        18.975,
        72.8258,
        ["Porte de l'Inde", 18.922, 72.8347],
        ["Shivaji Park", 19.0268, 72.8383],
      ),
      city(
        "Calcutta",
        22.5726,
        88.3639,
        ["New Market", 22.56, 88.3528],
        ["College Square", 22.5748, 88.3638],
      ),
    ],
  },
  {
    iso: "VN",
    name: "Viêt Nam",
    lang: "fr",
    cities: [
      city(
        "Hanoï",
        21.0278,
        105.8342,
        ["Lac Hoàn Kiếm", 21.0287, 105.8524],
        ["Place Ba Đình", 21.0368, 105.8346],
      ),
      city(
        "Hô Chi Minh-Ville",
        10.7769,
        106.7009,
        ["Marché Bến Thành", 10.7725, 106.698],
        ["Rue Nguyễn Huệ", 10.774, 106.7035],
      ),
    ],
  },
  // Océanie
  {
    iso: "AU",
    name: "Australie",
    lang: "en",
    cities: [
      city(
        "Sydney",
        -33.8688,
        151.2093,
        ["Martin Place", -33.8678, 151.21],
        ["Hyde Park", -33.8731, 151.2113],
      ),
      city(
        "Melbourne",
        -37.8136,
        144.9631,
        ["Federation Square", -37.818, 144.9691],
        ["Queen Victoria Market", -37.8076, 144.9568],
      ),
    ],
  },
];

/** A geo_units row, as the seed inserts it. */
export interface AbroadUnit {
  id: string;
  parent_id: string | null;
  level: "country" | "locality";
  country: string;
  name: string;
  code: null;
  lat: number | null;
  lng: number | null;
  source: "overture";
  geo_release: string;
}

/** A lieu's place columns, placed at a city abroad (placed_location and placed_rules aside). */
export interface AbroadPlace {
  place_unit: string;
  place_path: string[];
  locality_id: string;
  lieu_key: string;
  lat: number;
  lng: number;
  place_precision: "locality";
  place_candidates: null;
  geo_release: string;
}

/** A lieu abroad: an audition's location, where it is, and the place columns it holds. */
export interface AbroadLieu {
  country: AbroadCountry;
  city: AbroadCity;
  /** "<place>, <city>": the city is the locality's name, which the pin label drops. */
  location: string;
  place: AbroadPlace;
}

/**
 * A locality's unit id: the first 32 hex digits of the sha256 of
 * "<iso>:<city>", written 8-4-4-4-12. The same city always gets the same id.
 */
export function localityId(iso: string, cityName: string): string {
  const h = createHash("sha256").update(`${iso}:${cityName}`, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Every lieu of the fixture, in its order: countries, their cities, their places. */
export function abroadLieux(): AbroadLieu[] {
  return ABROAD.flatMap((country) =>
    country.cities.flatMap((c) => {
      const unit = localityId(country.iso, c.name);
      return c.spots.map((spot) => {
        const location = `${spot.name}, ${c.name}`;
        return {
          country,
          city: c,
          location,
          place: {
            place_unit: unit,
            place_path: [country.iso, unit],
            locality_id: unit,
            lieu_key: normalizeLocation(location),
            lat: spot.lat,
            lng: spot.lng,
            place_precision: "locality" as const,
            place_candidates: null,
            geo_release: ABROAD_GEO_RELEASE,
          },
        };
      });
    }),
  );
}

/** The place columns of every lieu of the fixture, by location. */
export function abroadPlaces(): Record<string, AbroadPlace> {
  return Object.fromEntries(abroadLieux().map((l) => [l.location, l.place]));
}

/** The geo_units rows the fixture's places reference: the countries, then their localities. */
export function abroadUnits(): AbroadUnit[] {
  const unit = (u: Pick<AbroadUnit, "id" | "parent_id" | "level" | "country" | "name">) => ({
    code: null,
    lat: null,
    lng: null,
    source: "overture" as const,
    geo_release: ABROAD_GEO_RELEASE,
    ...u,
  });
  return [
    ...ABROAD.map(({ iso, name }) =>
      unit({ id: iso, parent_id: null, level: "country", country: iso, name }),
    ),
    ...ABROAD.flatMap(({ iso, cities }) =>
      cities.map((c) => ({
        ...unit({
          id: localityId(iso, c.name),
          parent_id: iso,
          level: "locality",
          country: iso,
          name: c.name,
        }),
        lat: c.lat,
        lng: c.lng,
      })),
    ),
  ];
}
