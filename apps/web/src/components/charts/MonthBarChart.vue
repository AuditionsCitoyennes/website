<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  data: { label: string; count: number }[];
}>();

// SVG geometry (viewBox units — the chart scales with its container).
const W = 640;
const H = 300;
const PAD = { top: 16, right: 12, bottom: 64, left: 36 };

const innerW = W - PAD.left - PAD.right;
const innerH = H - PAD.top - PAD.bottom;

const maxCount = computed(() => Math.max(1, ...props.data.map((d) => d.count)));

// Round y-axis steps: at most 5 gridlines on integers.
const ySteps = computed(() => {
  const max = maxCount.value;
  const step = Math.max(1, Math.ceil(max / 4));
  const steps: number[] = [];
  for (let v = 0; v <= max; v += step) steps.push(v);
  if (steps[steps.length - 1] < max) steps.push(max);
  return steps;
});

const yMax = computed(() => ySteps.value[ySteps.value.length - 1]);

const bars = computed(() => {
  const n = props.data.length;
  if (n === 0) return [];
  const slot = innerW / n;
  const barW = Math.min(46, slot * 0.62);
  return props.data.map((d, i) => {
    const h = (d.count / yMax.value) * innerH;
    return {
      ...d,
      x: PAD.left + slot * i + (slot - barW) / 2,
      y: PAD.top + innerH - h,
      w: barW,
      h,
      cx: PAD.left + slot * i + slot / 2,
    };
  });
});

function yFor(value: number): number {
  return PAD.top + innerH - (value / yMax.value) * innerH;
}
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${H}`" class="chart" role="img" aria-label="Auditions par mois">
    <!-- gridlines + y labels -->
    <g v-for="v in ySteps" :key="v">
      <line :x1="PAD.left" :x2="W - PAD.right" :y1="yFor(v)" :y2="yFor(v)" class="grid" />
      <text :x="PAD.left - 8" :y="yFor(v) + 4" class="y-label">{{ v }}</text>
    </g>

    <!-- bars -->
    <g v-for="b in bars" :key="b.label">
      <rect :x="b.x" :y="b.y" :width="b.w" :height="b.h" rx="5" class="bar">
        <title>{{ b.label }} : {{ b.count }} audition{{ b.count > 1 ? "s" : "" }}</title>
      </rect>
      <text
        :x="b.cx"
        :y="H - PAD.bottom + 14"
        class="x-label"
        :transform="`rotate(-38 ${b.cx} ${H - PAD.bottom + 14})`"
      >
        {{ b.label }}
      </text>
    </g>
  </svg>
</template>

<style scoped>
.chart {
  width: 100%;
  height: auto;
  display: block;
}

.grid {
  stroke: hsl(var(--border));
  stroke-dasharray: 3 3;
}

.bar {
  fill: hsl(var(--primary));
}

.bar:hover {
  filter: brightness(1.15);
}

.y-label {
  fill: hsl(var(--muted-foreground));
  font-size: 11px;
  text-anchor: end;
}

.x-label {
  fill: hsl(var(--muted-foreground));
  font-size: 10.5px;
  text-anchor: end;
}
</style>
