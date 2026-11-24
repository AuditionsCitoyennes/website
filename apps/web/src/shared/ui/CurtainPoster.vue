<script setup lang="ts">
// France on the map's loading curtain (MapCurtain.vue), where curtainFrame.ts
// puts it: its outline as the map shows it, flat on the globe or tilted (its
// points projected, drawn as plain paths: a CSS 3D tilt rasterises blurry). Its own small file: the curtain is in every page's code, the
// poster's outline is not (MapStage's StageLoading asks for it, GeoNav
// imports it with the map's code). Decorative, as the poster.
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import { POSTER_REGIONS } from "./francePoster";
import { posterRings, type PosterRing } from "./francePosterRings";
import type { CurtainLayout, FranceAim } from "@/shared/boot/curtainFrame";
import { projectRings } from "@/shared/boot/curtainProject";

const props = defineProps<{ poster: CurtainLayout["poster"] }>();

let rings: PosterRing[] | null = null;
let counts: number[] = [];
/** Every région's rings, read once. */
function allRings(): PosterRing[] {
  if (!rings) {
    const per = POSTER_REGIONS.map((r) => posterRings(r.d));
    counts = per.map((r) => r.length);
    rings = per.flat();
  }
  return rings;
}

type Projected = CurtainLayout["poster"];

/** One path per région, as the poster. */
function project(p: Projected): string[] {
  const out = projectRings(allRings(), p);
  const paths: string[] = [];
  let at = 0;
  for (const n of counts) {
    let d = "";
    for (const ring of out.slice(at, at + n)) {
      d +=
        ring.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("") + "Z";
    }
    at += n;
    paths.push(d);
  }
  return paths;
}

// The box changing over many frames (the home card growing into the page,
// MapStage's 0.65 s transition; a window dragged wider) would project the
// outline at each: about a millisecond, then its paths parsed again, while a
// weak phone is also booting the map. So a change after a quiet spell is
// projected at once (the curtain's first frame, a turned phone), and the
// ones that follow it within SETTLE_MS only move and scale the last drawing
// onto the new aim (a transform); the outline is projected again once the
// box has held still that long.
const SETTLE_MS = 150;
const drawn = shallowRef<{ paths: string[]; aim: FranceAim; flat: boolean } | null>(null);
let settle: ReturnType<typeof setTimeout> | undefined;
let lastChange = 0;

function draw() {
  const p = props.poster;
  drawn.value = { paths: project(p), aim: p.aim, flat: p.flat };
}

watch(
  () => props.poster,
  (p) => {
    const now = performance.now();
    const busy = settle !== undefined || now - lastChange < SETTLE_MS;
    lastChange = now;
    if (!drawn.value || !busy || drawn.value.flat !== p.flat) {
      draw();
      return;
    }
    if (settle !== undefined) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = undefined;
      draw();
    }, SETTLE_MS);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (settle !== undefined) clearTimeout(settle);
});

const tilted = computed(() => drawn.value?.paths ?? []);

/** The last drawing moved and scaled onto today's aim, while the box moves. */
const tiltStyle = computed(() => {
  const d = drawn.value;
  const p = props.poster;
  if (!d) return undefined;
  const a = d.aim;
  const b = p.aim;
  if (a.x === b.x && a.y === b.y && a.width === b.width) return undefined;
  const k = a.width > 0 ? b.width / a.width : 1;
  return {
    transformOrigin: "0 0",
    transform: `translate(${b.x}px, ${b.y}px) scale(${k}) translate(${-a.x}px, ${-a.y}px)`,
  };
});
</script>

<template>
  <svg
    class="curtain-poster curtain-tilted"
    :style="tiltStyle"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(d, i) in tilted" :key="i" :d="d" />
  </svg>
</template>

<style scoped>
.curtain-poster {
  position: absolute;
  opacity: 0.45;
}

.curtain-tilted {
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

/* FrancePoster.vue's paths. */
.curtain-tilted path {
  fill: var(--poster-fill, hsl(var(--primary) / 0.16));
  stroke: var(--poster-stroke, hsl(var(--primary) / 0.55));
  stroke-width: 1.2;
  stroke-linejoin: round;
}
</style>
