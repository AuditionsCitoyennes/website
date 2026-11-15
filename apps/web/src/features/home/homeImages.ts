// The home page's photographs: free licences (Pexels / Unsplash Licence, CC0)
// — no attribution required, the photographer is credited anyway. People of
// all ages talking together in open public places — quays, parks, streets —
// in warm natural light (not cafés or restaurants), the people clearly in sight.
//
// Pure: read by vite.config.ts at build time (the HTML's early ask for the
// hero, shared/boot/homeBootPlan.ts) and by node (homeImages.test.ts).

import type { Hero, ImageSource } from "../../shared/boot/homeBootPlan";

export interface HomeImage {
  /** The image itself, without size parameters (see `srcFor`). */
  src: string;
  alt: string;
  /** Photographer and source, for the credit line. */
  credit: string;
  /** Where to crop from when the frame is narrower than the photo. */
  position?: string;
  /** Hero only: the title goes at the top — the people are in the lower part
   *  of the photo, and must stay in sight (default: at the bottom). */
  textAt?: "top" | "bottom";
}

/** The full-screen photograph at the top of the page. */
export const HERO_IMAGE: HomeImage = {
  src: "https://images.unsplash.com/photo-1611677233318-de54d11b189e",
  alt: "Sur les quais de Seine, au soleil du soir, des groupes de gens assis au bord de l'eau discutent",
  credit: "Venus Major / Unsplash",
  position: "50% 60%",
  textAt: "top",
};

/** The project's photograph, under its catch phrase and the "Témoigner" button. */
export const PROJECT_IMAGE: HomeImage = {
  src: "https://images.pexels.com/photos/16934845/pexels-photo-16934845.jpeg",
  alt: "Des gens de tous âges qui discutent et rient lors d'un rassemblement dans un parc",
  credit: "Samuel Peter / Pexels",
  position: "60% 50%",
};

/** Wikimedia Commons serves its thumbnails at these widths only. */
const COMMONS_STEPS = [960, 1280, 1920];

const isCommons = (img: HomeImage) => img.src.includes("upload.wikimedia.org/wikipedia/commons/");

/** The photo at `width` pixels wide (each host resizes on the fly). */
export function srcFor(img: HomeImage, width: number): string {
  if (img.src.includes("images.unsplash.com")) {
    return `${img.src}?auto=format&fit=crop&q=75&w=${width}`;
  }
  // Wikimedia Commons: its thumbnail path, …/thumb/<a>/<ab>/<file>/<w>px-<file>
  // — at one of the widths it serves (others are refused), 1920 at most.
  const commons = /^(https:\/\/upload\.wikimedia\.org\/wikipedia\/commons)\/(.+\/)([^/]+)$/.exec(
    img.src,
  );
  if (commons) {
    const step = COMMONS_STEPS.find((w) => w >= width) ?? COMMONS_STEPS[COMMONS_STEPS.length - 1];
    return `${commons[1]}/thumb/${commons[2]}${commons[3]}/${step}px-${commons[3]}`;
  }
  return `${img.src}?auto=compress&cs=tinysrgb&w=${width}`;
}

/** A `srcset` across the usual screen widths — each with the width actually
 *  served (Commons rounds up to its own steps), once. */
export function srcsetFor(img: HomeImage, widths: number[]): string {
  const served = isCommons(img)
    ? widths.map(
        (w) => COMMONS_STEPS.find((s) => s >= w) ?? COMMONS_STEPS[COMMONS_STEPS.length - 1],
      )
    : widths;
  return [...new Set(served)].map((w) => `${srcFor(img, w)} ${w}w`).join(", ");
}

/** The hero's copies for every screen today ("ancien"), and its slot: the
 *  photo covers the hero, whose height is the screen's (less the header on a
 *  desktop), so on a screen narrower than 3:2 it is drawn wider than the
 *  screen. */
export const HERO_WIDTHS = [960, 1440, 1920, 2560];
export const HERO_SIZES = "(max-aspect-ratio: 3/2) calc((100vh - 4rem) * 1.5), 100vw";

/** Quality of the portrait copies: the photo sits under a dark shade, where
 *  the difference with 75 does not show. */
export const PORTRAIT_QUALITY = 55;

/**
 * The portrait copies, narrowest first: for a screen at most `maxAspect`
 * (width / height), the photo cut to that shape around its centre — what the
 * hero shows of it there anyway (object-fit: cover, centred across) — in the
 * widths given. Its slot: the hero's height (the whole screen on a phone)
 * times the cut's ratio.
 */
export const HERO_PORTRAIT_CUTS: readonly {
  maxAspect: readonly [number, number];
  widths: readonly number[];
}[] = [
  { maxAspect: [1, 2], widths: [540, 720, 840, 1080] },
  { maxAspect: [3, 4], widths: [720, 1080] },
];

/** The photo cut to `width` × `height` around its centre (Unsplash alone; null elsewhere). */
export function cutSrcFor(img: HomeImage, width: number, height: number): string | null {
  if (!img.src.includes("images.unsplash.com")) return null;
  return `${img.src}?auto=format&fit=crop&crop=center&q=${PORTRAIT_QUALITY}&w=${width}&h=${height}`;
}

/** The hero's sources in a mode of `ac:hero` (shared/boot/homeBootPlan.ts):
 *  "ancien", today's copies alone; otherwise the portrait cuts first (when the
 *  host can cut), then today's copies for every other screen. */
export function heroSources(img: HomeImage, mode: Hero): ImageSource[] {
  const legacy: ImageSource = {
    maxAspect: null,
    srcset: srcsetFor(img, HERO_WIDTHS),
    sizes: HERO_SIZES,
  };
  if (mode === "ancien" || !cutSrcFor(img, 1, 1)) return [legacy];
  const cuts = HERO_PORTRAIT_CUTS.map(({ maxAspect: [w, h], widths }): ImageSource => ({
    maxAspect: [w, h],
    srcset: widths
      .map((width) => `${cutSrcFor(img, width, Math.round((width * h) / w))} ${width}w`)
      .join(", "),
    // The slot's width: the hero's height times the cut's ratio.
    sizes: `calc(100vh * ${w} / ${h})`,
  }));
  return [...cuts, legacy];
}
