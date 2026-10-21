import { headerBottomPx, isPhone } from "@/shared/dom/header";
import type { StageRect } from "./useMapStage";

// The card growing into the page: how long it takes, the frames it waits for,
// and where it ends.

export const GROW_MS = 650;

/** A frame painted — or a moment, where frames are held back (a hidden tab). */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, 60);
    requestAnimationFrame(() => requestAnimationFrame(done));
  });
}

/** The growth's end — or its time, should the event never come. */
export function grown(el: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      el.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
      resolve();
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === el && e.propertyName === "height") done();
    };
    el.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(done, GROW_MS + 150);
  });
}

/** Where the page will hold the map: under the header — or right from the
 *  top on a phone, where the header floats over the map page. */
export function pageRect(): StageRect {
  const top = isPhone() ? 0 : headerBottomPx();
  const width = document.documentElement.clientWidth;
  return { top, left: 0, width, height: window.innerHeight - top };
}
