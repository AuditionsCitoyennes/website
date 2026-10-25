// The ring's reader: which part is picked, which a mouse is over, which has
// the focus, which was said — and the radio group its targets make (WAI-ARIA):
// the arrows go round it picking as they go, Home and End to its ends, Enter
// or Space picks the part focused. The ring itself — its parts, largest first
// — is content, handed in as a computed; the overlay owns the DOM and tells
// the map the pick (setRing).
import { computed, nextTick, ref, watch, type ComputedRef } from "vue";
import type { AuditionTheme } from "@ac/shared";
import type { Ring } from "../content/ring";

export function useRingPick(ring: ComputedRef<Ring | null>) {
  /** The part of the ring the reader picked (null: none yet — the largest
   *  stands picked, see ringPicked). */
  const picked = ref<AuditionTheme | null>(null);

  /** The part picked: the reader's pick while the ring has it, else the
   *  largest (the ring runs largest first) — one always is, once there are
   *  parts. Another territory, or the pick taken out of the ring by the filters,
   *  starts again from the largest (see reset, the watcher on the ring). */
  const ringPicked = computed(() => {
    const parts = ring.value?.parts;
    if (!parts?.length) return null;
    const t = picked.value;
    return t && parts.some((p) => p.theme === t) ? t : parts[0].theme;
  });
  /** The part a mouse is over, and the part with the focus — and whether that
   *  focus is a keyboard's (then its focus ring is drawn). */
  const hovered = ref<AuditionTheme | null>(null);
  const focused = ref<AuditionTheme | null>(null);
  const focusShown = ref(false);
  /** The ring's one tab stop (a roving tabindex): the picked part — or, while
   *  the focus is in the ring on another (a pointer picked elsewhere, a screen
   *  reader moved it), the part it is on, so that Tab and Shift+Tab leave the
   *  ring from there. */
  const rover = ref<AuditionTheme | null>(null);
  const tabStop = computed(() => {
    const r = rover.value;
    return r && ring.value?.parts.some((p) => p.theme === r) ? r : ringPicked.value;
  });

  /** A part only looked at — under the mouse —: named in the pick's stead for
   *  as long, then the picked one again. (The keyboard picks as it goes: the
   *  part it is on is the picked one.) */
  const previewPart = computed(() => {
    const t = hovered.value;
    return t && t !== ringPicked.value ? t : null;
  });
  /** The part the label names: a preview, else the picked one. */
  const shownPart = computed(() => {
    const t = previewPart.value ?? ringPicked.value;
    return t ? (ring.value?.parts.find((p) => p.theme === t) ?? null) : null;
  });
  /** The theme a pointer has just picked, said as its label shows. Not one the
   *  keyboard picks (nor a screen reader's own press): the focus is on its
   *  part, whose name and state say the whole label — said here as well, it
   *  would be heard twice. Nor the largest, picked by default (each territory
   *  the map crossed would be read out), nor a preview (the part's own name
   *  says it all), nor the pick shown again after one: whatever else the label
   *  shows lets it go. */
  const said = ref<AuditionTheme | null>(null);
  watch(
    () => shownPart.value?.theme ?? null,
    (t) => {
      if (t !== said.value) said.value = null;
    },
  );
  const labelSaid = computed(() => said.value !== null && said.value === shownPart.value?.theme);

  /** The focus ring, around the focused part (grown out when picked or hovered). */
  const focusPath = computed(() => {
    const t = focusShown.value ? focused.value : null;
    const p = t ? ring.value?.parts.find((x) => x.theme === t) : undefined;
    if (!p) return null;
    return p.theme === ringPicked.value || p.theme === hovered.value ? p.focusOut : p.focus;
  });

  const ringEl = ref<SVGSVGElement | null>(null);

  function partOf(target: EventTarget | null) {
    const t = (target as Element | null)?.getAttribute?.("data-theme");
    return t ? (ring.value?.parts.find((p) => p.theme === t) ?? null) : null;
  }

  function keyboardFocus(el: Element): boolean {
    try {
      return el.matches(":focus-visible");
    } catch {
      return true; // no :focus-visible: always drawn
    }
  }

  function onRingFocusIn(e: FocusEvent) {
    const p = partOf(e.target);
    if (!p) return;
    focused.value = p.theme;
    rover.value = p.theme;
    focusShown.value = keyboardFocus(e.target as Element);
  }

  // Out of the ring, its tab stop is the picked part again.
  function onRingFocusOut(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (next && ringEl.value?.contains(next)) return;
    focused.value = null;
    focusShown.value = false;
    rover.value = null;
  }

  function onPartEnter(e: PointerEvent, theme: AuditionTheme) {
    if (e.pointerType === "mouse") hovered.value = theme;
  }

  function onPartLeave(theme: AuditionTheme) {
    if (hovered.value === theme) hovered.value = null;
  }

  // The ring is one radio group, as any (WAI-ARIA's radio group): the arrows go
  // round it (in its order, largest first, wrapping), Home and End to its ends,
  // and the part reached is picked as the focus lands on it; Enter or Space
  // picks the part focused too. Escape is left to the layer (onEscape).
  function onRingKey(e: KeyboardEvent) {
    const parts = ring.value?.parts;
    const at = parts ? parts.findIndex((p) => p.theme === focused.value) : -1;
    if (!parts || at < 0) return;
    const n = parts.length;
    let to: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        to = (at + 1) % n;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        to = (at - 1 + n) % n;
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = n - 1;
        break;
      case "Enter":
      case " ":
        to = at;
        break;
      default:
        return;
    }
    e.preventDefault();
    pick(parts[to].theme, false);
    if (to === at) return;
    rover.value = parts[to].theme;
    // Once the part is drawn checked (and the tab stop): the focus landing on
    // it reads it so.
    void nextTick(() =>
      ringEl.value?.querySelectorAll<SVGGElement>(".part")[to]?.focus({ preventScroll: true }),
    );
  }

  /** A part pressed with a pointer (`detail` ≥ 1, the presses counted): said.
   *  A click with no press behind it is a screen reader's own: it acts on the
   *  part its cursor is on, which says itself. */
  function onPartClick(e: MouseEvent, theme: AuditionTheme) {
    pick(theme, e.detail > 0);
  }

  /** A part picked by the reader: it stays picked — pressed again, it is kept —
   *  until another is, or the territory changes. Said only when asked (a
   *  pointer's pick, see `said`). */
  function pick(theme: AuditionTheme, say: boolean) {
    picked.value = theme;
    said.value = say ? theme : null;
  }

  // A theme picked in Filtres leaves the ring (it is in every testimony
  // counted): picked on the ring, it is let go — the largest left is picked.
  watch(ring, (r) => {
    const t = picked.value;
    if (t && !r?.parts.some((p) => p.theme === t)) picked.value = null;
  });

  /** Another territory: its largest theme picked, and not said; no part
   *  hovered, the tab stop the picked part again. */
  function reset() {
    picked.value = null;
    said.value = null;
    hovered.value = null;
    rover.value = null;
  }

  return {
    picked,
    ringPicked,
    hovered,
    said,
    tabStop,
    shownPart,
    labelSaid,
    focusPath,
    ringEl,
    onRingFocusIn,
    onRingFocusOut,
    onPartEnter,
    onPartLeave,
    onRingKey,
    onPartClick,
    reset,
  };
}
