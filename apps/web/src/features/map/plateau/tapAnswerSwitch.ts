// How a tap on a territory is answered while its plateau is on its way: the
// PENDING mark, shown on the tapped unit from the tap until its plateau
// commits (gl/PendingMarkPass.ts draws it, geo-nav's model/tapPendingCore.ts
// decides when it ends). Two switches, compared live in the builds with the
// testing tools — the dev server and staging (__TEST_TOOLS__, vite.config),
// kept in localStorage and drawn as the Témoignages page's DEV rows « Réponse
// au toucher » and « Image du toucher ». Read at each tap: no reload.
//
// `ac:tap-answer`, what the mark is:
// - "auto" (the default): a still, lighter, thicker stroke along the unit's
//   boundary on every device, and on a touch screen, which has no hover, a
//   flat violet fill as well; the unit's pill wears the pending look.
// - "stroke": the stroke and the pill, never the fill.
// - "fill": the flat violet fill and the pill on every device, no stroke.
// - "off": no mark, no pill, nothing said to a screen reader: the map as it
//   was before the mark existed.
//
// `ac:tap-frame`, when the mark is first drawn:
// - "same" (the default): the mark is set in the task that also writes the
//   selection, so it shows in the first frame of the flight. No frame added.
// - "own": the mark is set and painted in a frame of its own; the selection
//   (the scope, the pins, the grey, the camera) is written right after that
//   frame. One frame later for everything else.
//
// Production has neither key nor row: DEFAULT_TAP_ANSWER, DEFAULT_TAP_FRAME.

import { ref } from "vue";

export type TapAnswerMode = "auto" | "stroke" | "fill" | "off";
export type TapFrameMode = "same" | "own";

/** The modes of a build without the testing tools, and the switches' defaults. */
export const DEFAULT_TAP_ANSWER: TapAnswerMode = "auto";
export const DEFAULT_TAP_FRAME: TapFrameMode = "same";

export const TAP_ANSWER_MODES: readonly TapAnswerMode[] = ["auto", "stroke", "fill", "off"];
export const TAP_FRAME_MODES: readonly TapFrameMode[] = ["same", "own"];

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
 *  without the testing tools reads no key: the defaults. */
export const tapAnswerMode = ref<TapAnswerMode>(
  __TEST_TOOLS__
    ? stored("ac:tap-answer", TAP_ANSWER_MODES, DEFAULT_TAP_ANSWER)
    : DEFAULT_TAP_ANSWER,
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

/** Another first frame: kept, and in force from the next tap. */
export function setTapFrameMode(mode: TapFrameMode) {
  if (!__TEST_TOOLS__) return;
  tapFrameMode.value = mode;
  store("ac:tap-frame", mode);
}

/** What a tap's mark is made of. `pill`: the unit's pill wears the pending
 *  look. All false: no pending state at all. */
export interface TapMark {
  stroke: boolean;
  fill: boolean;
  pill: boolean;
}

/** The mark of a tap made with a touch (or a pen: no hover either) or a
 *  mouse, under `mode`. */
export function tapMarkFor(mode: TapAnswerMode, touch: boolean): TapMark {
  switch (mode) {
    case "off":
      return { stroke: false, fill: false, pill: false };
    case "stroke":
      return { stroke: true, fill: false, pill: true };
    case "fill":
      return { stroke: false, fill: true, pill: true };
    default:
      return { stroke: true, fill: touch, pill: true };
  }
}

/** Whether a tap was made by something that cannot hover: the type of the
 *  pointer last seen going down on the page, or, when none was (a key on a
 *  row before any pointer), a device whose main pointer does not hover. */
export function tapIsTouch(lastPointerType: string | undefined, hoverCapable: boolean): boolean {
  if (lastPointerType) return lastPointerType !== "mouse";
  return !hoverCapable;
}
