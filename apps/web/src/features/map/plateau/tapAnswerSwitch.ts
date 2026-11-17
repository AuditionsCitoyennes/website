// How a tap on a territory is answered while the data of its plateau comes
// in: the PENDING mark, shown on the tapped unit from the tap until its
// plateau rises (gl/PendingMarkPass.ts draws it, geo-nav's
// model/tapPendingCore.ts decides when the pending state ends). The same on
// every device, for a mouse, a finger, a pen or a key:
// - the unit is filled with flat violet at once, without rising, and its
//   pill wears the pending look;
// - a loading line runs along its boundary, covering the share of the
//   boundary's length that the data has reached (plateau/tapProgress.ts): 0
//   at the tap, the whole boundary when everything is in;
// - then the violet fades out, and only then the unit rises.
//
// Six switches, compared live in the builds with the testing tools — the dev
// server and staging (__TEST_TOOLS__, vite.config), kept in localStorage and
// drawn as the Témoignages page's DEV rows « Réponse au toucher », « Couleur
// de la ligne », « Avancée de la ligne », « Toucher rapide », « Fin du
// chargement » and « Image du toucher ». Read at each tap: no reload.
//
// `ac:tap-answer`, the mark: "line" (the default: the above) or "off" (no
// mark, no pill, nothing said to a screen reader).
//
// `ac:tap-line`, the loading line's colour, always one of the map's own
// violets, darker than the fill it runs over: "deep" (the default: the
// boundary lines' violet #7C5CFF, same hue, darker — it reads over the fill
// by its depth and stays blue-violet), "indigo" (a very dark violet: the
// strongest contrast of lightness, the heaviest line) and "site" (the hue
// of the site's buttons, --primary, darker). A value kept by an earlier
// build that is no longer one of these reads as the default.
//
// `ac:tap-steps`, how the line moves between two real steps: "steps" (the
// default: it moves only when a piece of data arrives, easing to its new
// length) or "creep" (it also slides a little while it waits — a few
// hundredths of the boundary past what has arrived, over the first seconds
// after the tap, never more, and never the whole boundary before
// everything is in: gl/pendingMark.ts MARK_CREEP_LEAD).
//
// `ac:tap-fast`, a tap whose data is in almost at once: "hide" (the
// default: the line is not drawn until a fifth of a second after the mark's
// first frame, and never when the data is all in before that — the violet,
// then the rise, no line; a line that does show starts from nothing and
// runs at a constant speed, the whole boundary in a quarter of a second at
// the fastest: gl/pendingMark.ts MARK_LINE_SHOW_MS, MARK_LINE_FULL_MS) or
// "show" (the line from the tap, each step an ease).
//
// `ac:tap-end`, the end: "then" (the default: the line whole, the violet
// fades out, the unit rises after) or "together" (the violet fades while it
// rises).
//
// `ac:tap-frame`, when the mark is first drawn:
// - "same" (the default): the mark is set in the task that also writes the
//   selection, so it shows in the first frame of the flight. No frame added.
// - "own": the mark is set and painted in a frame of its own; the selection
//   (the scope, the pins, the grey, the camera) is written right after that
//   frame. One frame later for everything else.
//
// Production has neither key nor row: the DEFAULT_* below.

import { ref } from "vue";

export type TapAnswerMode = "line" | "off";
export type TapLineColor = "deep" | "indigo" | "site";
export type TapStepsMode = "steps" | "creep";
export type TapFastMode = "hide" | "show";
export type TapEndMode = "then" | "together";
export type TapFrameMode = "same" | "own";

/** The modes of a build without the testing tools, and the switches' defaults. */
export const DEFAULT_TAP_ANSWER: TapAnswerMode = "line";
export const DEFAULT_TAP_LINE: TapLineColor = "deep";
export const DEFAULT_TAP_STEPS: TapStepsMode = "steps";
export const DEFAULT_TAP_FAST: TapFastMode = "hide";
export const DEFAULT_TAP_END: TapEndMode = "then";
export const DEFAULT_TAP_FRAME: TapFrameMode = "same";

export const TAP_ANSWER_MODES: readonly TapAnswerMode[] = ["line", "off"];
export const TAP_LINE_COLORS: readonly TapLineColor[] = ["deep", "indigo", "site"];
export const TAP_STEPS_MODES: readonly TapStepsMode[] = ["steps", "creep"];
export const TAP_FAST_MODES: readonly TapFastMode[] = ["hide", "show"];
export const TAP_END_MODES: readonly TapEndMode[] = ["then", "together"];
export const TAP_FRAME_MODES: readonly TapFrameMode[] = ["same", "own"];

/** The loading line's colours, straight sRGB 0..1: #3514B8 (the map's
 *  violet, darker), #24126E, #4D1F7A (the site's --primary hue, darker). */
export const TAP_LINE_RGB: Readonly<Record<TapLineColor, readonly [number, number, number]>> = {
  deep: [0.208, 0.078, 0.722],
  indigo: [0.141, 0.071, 0.431],
  site: [0.302, 0.122, 0.478],
};

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked (a private window): the choice lasts for this page */
  }
}

/** The modes now (refs: the DEV dialog redraws its rows from them). A build
 *  without the testing tools reads no key: the defaults. A value kept by an
 *  earlier build that no longer exists ("auto", "stroke", "fill", a line
 *  colour no longer offered) is the default. */
export const tapAnswerMode = ref<TapAnswerMode>(
  __TEST_TOOLS__
    ? stored("ac:tap-answer", TAP_ANSWER_MODES, DEFAULT_TAP_ANSWER)
    : DEFAULT_TAP_ANSWER,
);
export const tapLineColor = ref<TapLineColor>(
  __TEST_TOOLS__ ? stored("ac:tap-line", TAP_LINE_COLORS, DEFAULT_TAP_LINE) : DEFAULT_TAP_LINE,
);
export const tapStepsMode = ref<TapStepsMode>(
  __TEST_TOOLS__ ? stored("ac:tap-steps", TAP_STEPS_MODES, DEFAULT_TAP_STEPS) : DEFAULT_TAP_STEPS,
);
export const tapFastMode = ref<TapFastMode>(
  __TEST_TOOLS__ ? stored("ac:tap-fast", TAP_FAST_MODES, DEFAULT_TAP_FAST) : DEFAULT_TAP_FAST,
);
export const tapEndMode = ref<TapEndMode>(
  __TEST_TOOLS__ ? stored("ac:tap-end", TAP_END_MODES, DEFAULT_TAP_END) : DEFAULT_TAP_END,
);
export const tapFrameMode = ref<TapFrameMode>(
  __TEST_TOOLS__ ? stored("ac:tap-frame", TAP_FRAME_MODES, DEFAULT_TAP_FRAME) : DEFAULT_TAP_FRAME,
);

/** Another mark: kept, and in force from the next tap. */
export function setTapAnswerMode(mode: TapAnswerMode) {
  if (!__TEST_TOOLS__) return;
  tapAnswerMode.value = mode;
  store("ac:tap-answer", mode);
}

/** Another colour for the line: kept, and in force from the next tap. */
export function setTapLineColor(color: TapLineColor) {
  if (!__TEST_TOOLS__) return;
  tapLineColor.value = color;
  store("ac:tap-line", color);
}

/** Another way for the line to move: kept, and in force from the next tap. */
export function setTapStepsMode(mode: TapStepsMode) {
  if (!__TEST_TOOLS__) return;
  tapStepsMode.value = mode;
  store("ac:tap-steps", mode);
}

/** Another answer to a fast tap: kept, and in force from the next tap. */
export function setTapFastMode(mode: TapFastMode) {
  if (!__TEST_TOOLS__) return;
  tapFastMode.value = mode;
  store("ac:tap-fast", mode);
}

/** Another end: kept, and in force from the next tap. */
export function setTapEndMode(mode: TapEndMode) {
  if (!__TEST_TOOLS__) return;
  tapEndMode.value = mode;
  store("ac:tap-end", mode);
}

/** Another first frame: kept, and in force from the next tap. */
export function setTapFrameMode(mode: TapFrameMode) {
  if (!__TEST_TOOLS__) return;
  tapFrameMode.value = mode;
  store("ac:tap-frame", mode);
}

/** What a tap's mark is made of. `pill`: the unit's pill wears the pending
 *  look. All false: no pending state at all. */
export interface TapMark {
  line: boolean;
  fill: boolean;
  pill: boolean;
}

/** The mark of a tap under `mode`, whatever made it. */
export function tapMarkFor(mode: TapAnswerMode): TapMark {
  return mode === "off"
    ? { line: false, fill: false, pill: false }
    : { line: true, fill: true, pill: true };
}
