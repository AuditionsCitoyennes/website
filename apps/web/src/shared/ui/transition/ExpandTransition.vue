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
//
// Under short motion (shared/device/motion: the system asks for reduced
// motion, or a weak device) there is no tween: the block is open or closed
// in one step, so no frame lays out a body thousands of pixels tall.
import { motionNow } from "@/shared/device/motion";

const props = withDefaults(
  defineProps<{
    /**
     * Collapse with no tween (the expand still animates). For a single-open
     * accordion: when opening another panel closes the current one, tweening
     * that collapse drags everything below it upward for the whole duration —
     * including the header just clicked. Dropping it in one step keeps the
     * layout shift to a single, correctable jump.
     */
    instantLeave?: boolean;
  }>(),
  { instantLeave: false },
);

const DURATION = 460;

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
  if (motionNow() === "short") {
    runCleanup(node); // a collapse still mid-flight must not fight this
    // What an instant collapse left on a v-show'd node.
    node.style.height = "";
    node.style.overflow = "";
    node.style.transition = "";
    done();
    return;
  }
  animate(node, "0px", `${node.scrollHeight}px`, true, done);
}

function onLeave(el: Element, done: () => void) {
  const node = el as HTMLElement;
  if (props.instantLeave || motionNow() === "short") {
    runCleanup(node); // an expand still mid-flight must not fight this
    node.style.overflow = "hidden";
    node.style.height = "0px";
    done();
    return;
  }
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
