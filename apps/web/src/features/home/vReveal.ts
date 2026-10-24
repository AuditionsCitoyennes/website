import type { Directive } from "vue";

/** Sections come in as they are scrolled to. */
export const vReveal: Directive<HTMLElement> = {
  mounted(el) {
    el.classList.add("reveal");
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        el.classList.add("revealed");
        io.disconnect();
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    (el as HTMLElement & { _reveal?: IntersectionObserver })._reveal = io;
  },
  unmounted(el) {
    (el as HTMLElement & { _reveal?: IntersectionObserver })._reveal?.disconnect();
  },
};
