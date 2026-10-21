import type { Directive } from "vue";

/**
 * `v-autogrow`: a textarea as tall as what is written in it — it never shows a
 * scrollbar of its own. The height the text needs is handed to the stylesheet
 * as `--autogrow-h`, which decides what to do with it (typically
 * `min-height: max(<a few lines>, var(--autogrow-h, 0px))`), so the textarea
 * keeps its own minimum, any share of free room a flex parent gives it, and
 * the user's drag on its corner.
 */

interface Grown {
  /** The value last measured: Vue re-renders for other reasons too. */
  value: string;
  width: number;
  ro: ResizeObserver;
  frame: number;
  onInput: () => void;
}

const grown = new WeakMap<HTMLTextAreaElement, Grown>();

/** What scrolls around `el`: collapsing it for a measure would pull them back. */
function scrollers(el: Element): Element[] {
  const out: Element[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === "auto" || y === "scroll") out.push(p);
  }
  if (document.scrollingElement) out.push(document.scrollingElement);
  return out;
}

function fit(el: HTMLTextAreaElement) {
  const g = grown.get(el);
  if (g) g.value = el.value;
  // Not laid out (a closed dialog): measured once it is, by the observer.
  if (!el.isConnected || el.clientWidth === 0) return;
  // Collapsed for an instant — no paint in between — its scrollHeight is the
  // text's own height. Everything that scrolls around it gets shorter at that
  // instant and would clamp its position: put back afterwards.
  const around = scrollers(el);
  const tops = around.map((s) => s.scrollTop);
  const { flex, minHeight, height } = el.style;
  el.style.flex = "none";
  el.style.minHeight = "0";
  el.style.height = "0";
  const need = el.scrollHeight + el.offsetHeight - el.clientHeight;
  el.style.flex = flex;
  el.style.minHeight = minHeight;
  el.style.height = height;
  el.style.setProperty("--autogrow-h", `${Math.ceil(need)}px`);
  around.forEach((s, i) => {
    if (s.scrollTop !== tops[i]) s.scrollTop = tops[i];
  });
}

export const vAutogrow: Directive<HTMLTextAreaElement> = {
  mounted(el) {
    const g: Grown = {
      value: el.value,
      width: el.clientWidth,
      frame: 0,
      // Typing: measured in the same task, before the frame is painted.
      onInput: () => fit(el),
      // A new width wraps the text anew. Measured on the next frame: resizing
      // the element inside its own observer's callback is a resize loop.
      ro: new ResizeObserver(() => {
        if (el.clientWidth === g.width) return;
        g.width = el.clientWidth;
        cancelAnimationFrame(g.frame);
        g.frame = requestAnimationFrame(() => fit(el));
      }),
    };
    grown.set(el, g);
    el.addEventListener("input", g.onInput);
    g.ro.observe(el);
    fit(el);
  },
  // A value set from outside (the form emptied after sending): no input event.
  updated(el) {
    if (el.value !== grown.get(el)?.value) fit(el);
  },
  beforeUnmount(el) {
    const g = grown.get(el);
    if (!g) return;
    g.ro.disconnect();
    cancelAnimationFrame(g.frame);
    el.removeEventListener("input", g.onInput);
    grown.delete(el);
  },
};
