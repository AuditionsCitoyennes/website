<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  data: { name: string; value: number }[];
}>();

// Same palette as the old Recharts pie.
const COLORS = [
  "hsl(270, 70%, 65%)",
  "hsl(160, 60%, 50%)",
  "hsl(45, 93%, 55%)",
  "hsl(0, 70%, 60%)",
  "hsl(200, 80%, 55%)",
  "hsl(320, 70%, 60%)",
];

const SIZE = 240;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R_OUT = 110;
const R_IN = 62;

const total = computed(() => props.data.reduce((s, d) => s + d.value, 0));

function polar(r: number, angle: number): [number, number] {
  const rad = ((angle - 90) * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
}

/** Donut segment path between two angles (degrees, clockwise from 12h). */
function arcPath(a0: number, a1: number): string {
  // Avoid a degenerate full-circle arc.
  const end = a1 - a0 >= 360 ? a0 + 359.99 : a1;
  const large = end - a0 > 180 ? 1 : 0;
  const [ox0, oy0] = polar(R_OUT, a0);
  const [ox1, oy1] = polar(R_OUT, end);
  const [ix1, iy1] = polar(R_IN, end);
  const [ix0, iy0] = polar(R_IN, a0);
  return [
    `M ${ox0} ${oy0}`,
    `A ${R_OUT} ${R_OUT} 0 ${large} 1 ${ox1} ${oy1}`,
    `L ${ix1} ${iy1}`,
    `A ${R_IN} ${R_IN} 0 ${large} 0 ${ix0} ${iy0}`,
    "Z",
  ].join(" ");
}

const segments = computed(() => {
  if (total.value === 0) return [];
  let angle = 0;
  return props.data.map((d, i) => {
    const sweep = (d.value / total.value) * 360;
    const seg = {
      ...d,
      path: arcPath(angle, angle + sweep),
      color: COLORS[i % COLORS.length],
      percent: Math.round((d.value / total.value) * 100),
    };
    angle += sweep;
    return seg;
  });
});
</script>

<template>
  <div class="donut-wrap">
    <svg
      :viewBox="`0 0 ${SIZE} ${SIZE}`"
      class="donut"
      role="img"
      aria-label="Répartition des thèmes"
    >
      <path v-for="s in segments" :key="s.name" :d="s.path" :fill="s.color" class="seg">
        <title>{{ s.name }} : {{ s.value }} ({{ s.percent }}%)</title>
      </path>
      <text :x="CX" :y="CY - 4" class="center-value">{{ total }}</text>
      <text :x="CX" :y="CY + 16" class="center-label">mentions</text>
    </svg>

    <ul class="legend">
      <li v-for="s in segments" :key="s.name" class="legend-item">
        <span class="swatch" :style="{ background: s.color }"></span>
        <span class="legend-name">{{ s.name }}</span>
        <span class="legend-value">{{ s.percent }}%</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.donut-wrap {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  flex-wrap: wrap;
}

.donut {
  width: min(240px, 100%);
  flex-shrink: 0;
  height: auto;
}

.seg:hover {
  filter: brightness(1.12);
}

.center-value {
  fill: hsl(var(--foreground));
  font-family: var(--font-display);
  font-size: 34px;
  text-anchor: middle;
}

.center-label {
  fill: hsl(var(--muted-foreground));
  font-size: 12px;
  text-anchor: middle;
}

.legend {
  list-style: none;
  padding: 0;
  margin: 0;
  flex: 1;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  font-size: 0.85rem;
}

.swatch {
  width: 0.8rem;
  height: 0.8rem;
  border-radius: 0.2rem;
  flex-shrink: 0;
}

.legend-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: hsl(var(--foreground));
}

.legend-value {
  color: hsl(var(--muted-foreground));
  font-weight: 600;
}
</style>
