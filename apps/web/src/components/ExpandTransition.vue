<script setup lang="ts">
// Animates a v-if'd block's height between 0 and its natural size — the
// classic accordion. Fully JS-driven (:css="false") so `height: auto` can
// be tweened, which CSS alone can't do. The slot must be a single element
// gated by v-if/v-show.
//
// Robust against interruption (rapid open/close): every run registers a
// per-element cleanup, and the *-cancelled hooks invoke it so no inline
// styles, listeners, or timers are stranded. A fallback timer guarantees
// done() even if `transitionend` never fires (e.g. 0px→0px content).

const DURATION = 280;

const cleanups = new WeakMap<HTMLElement, () => void>();

function runCleanup(node: HTMLElement) {
  const c = cleanups.get(node);
  if (c) {
    cleanups.delete(node);
    c();
  }
}

function animate(
  node: HTMLElement,
  from: string,
  to: string,
  resetHeight: boolean,
  done: () => void,
) {
  runCleanup(node); // cancel anything already animating this node

  node.style.overflow = "hidden";
  node.style.height = from;
  void node.offsetHeight; // commit the start value
  node.style.transition = `height ${DURATION}ms ease`;
  node.style.height = to;

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    node.removeEventListener("transitionend", onEnd);
    clearTimeout(timer);
    cleanups.delete(node);
    if (resetHeight) {
      node.style.height = "";
      node.style.overflow = "";
    }
    node.style.transition = "";
    done();
  };

  const onEnd = (e: TransitionEvent) => {
    if (e.target === node && e.propertyName === "height") finish();
  };
  node.addEventListener("transitionend", onEnd);
  const timer = setTimeout(finish, DURATION + 50);

  cleanups.set(node, () => {
    node.removeEventListener("transitionend", onEnd);
    clearTimeout(timer);
    node.style.height = "";
    node.style.overflow = "";
    node.style.transition = "";
  });
}

function onEnter(el: Element, done: () => void) {
  const node = el as HTMLElement;
  animate(node, "0px", `${node.scrollHeight}px`, true, done);
}

function onLeave(el: Element, done: () => void) {
  const node = el as HTMLElement;
  animate(node, `${node.scrollHeight}px`, "0px", false, done);
}

function onCancelled(el: Element) {
  runCleanup(el as HTMLElement);
}
</script>

<template>
  <Transition
    :css="false"
    @enter="onEnter"
    @leave="onLeave"
    @enter-cancelled="onCancelled"
    @leave-cancelled="onCancelled"
  >
    <slot />
  </Transition>
</template>
