// The viewport as the panel and the camera read it: a desktop or a phone (the
// 900 px line the panel's CSS turns on too), and the window's size.
import { onBeforeUnmount, ref } from "vue";

export function useViewport() {
  const desktopQuery = window.matchMedia("(min-width: 900px)");
  const isDesktop = ref(desktopQuery.matches);
  const onMedia = (e: MediaQueryListEvent) => (isDesktop.value = e.matches);
  desktopQuery.addEventListener("change", onMedia);
  onBeforeUnmount(() => desktopQuery.removeEventListener("change", onMedia));

  // The map's padding is derived from how much of the canvas the panel covers, so
  // the viewport size has to be reactive.
  const viewportW = ref(window.innerWidth);
  const viewportH = ref(window.innerHeight);
  const onViewportResize = () => {
    viewportW.value = window.innerWidth;
    viewportH.value = window.innerHeight;
  };
  window.addEventListener("resize", onViewportResize);
  onBeforeUnmount(() => window.removeEventListener("resize", onViewportResize));

  return { isDesktop, viewportW, viewportH };
}

export type Viewport = ReturnType<typeof useViewport>;
