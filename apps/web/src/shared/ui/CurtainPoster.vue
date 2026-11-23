<script setup lang="ts">
// France on the map's loading curtain (MapCurtain.vue), where curtainFrame.ts
// puts it: the flat poster in its box, or its outline tilted like the map's
// (its points projected, drawn as plain paths: a CSS 3D tilt rasterises
// blurry). Its own small file: the curtain is in every page's code, the
// poster's outline is not (MapStage's StageLoading asks for it, GeoNav
// imports it with the map's code). Decorative, as the poster.
import { computed } from "vue";
import FrancePoster from "./FrancePoster.vue";
import { POSTER_REGIONS } from "./francePoster";
import { posterRings, type PosterRing } from "./francePosterRings";
import type { CurtainLayout } from "@/shared/boot/curtainFrame";
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

const rectStyle = computed(() => {
  const p = props.poster;
  if (p.kind !== "rect") return undefined;
  const r = p.rect;
  return { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` };
});

/** One path per région, as the poster. */
const tilted = computed(() => {
  const p = props.poster;
  if (p.kind !== "carte") return [];
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
});
</script>

<template>
  <FrancePoster v-if="poster.kind === 'rect'" class="curtain-poster" :style="rectStyle" />
  <svg v-else class="curtain-poster curtain-tilted" aria-hidden="true" focusable="false">
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
