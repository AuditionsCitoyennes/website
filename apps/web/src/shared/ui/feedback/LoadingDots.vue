<script setup lang="ts">
// "Something is loading": a few dots crossing from left to right. Each one
// fades in on the left, rushes in, lingers in the middle — where they bunch up
// — rushes out and fades away on the right.
// `live: false` inside a live region of the caller's, so it is announced once.
withDefaults(defineProps<{ label?: string; live?: boolean }>(), {
  label: "Chargement…",
  live: true,
});

const DOTS = 5;
</script>

<template>
  <div class="loading-dots" :role="live ? 'status' : undefined">
    <span class="visually-hidden">{{ label }}</span>
    <span class="track" aria-hidden="true">
      <!-- A lane spans the whole track and carries its dot at its left end:
           moving the LANE by 100% of itself is moving the dot across the track. -->
      <span v-for="i in DOTS" :key="i" class="lane" :style="{ '--i': i - 1 }"></span>
    </span>
  </div>
</template>

<style scoped>
.loading-dots {
  display: flex;
  justify-content: center;
  padding: 0.6rem 0;
}

.track {
  position: relative;
  width: min(16rem, 80%);
  height: 0.35rem;
  /* The dots enter and leave already invisible, but not beyond the track. */
  overflow: hidden;
}

.lane {
  position: absolute;
  inset: 0;
  opacity: 0;
  /* Two clocks on one dot: where it is, and how visible. The move is eased
     over the whole crossing (see dots-cross); the fade just follows the time. */
  animation:
    dots-cross 2.8s infinite,
    dots-fade 2.8s linear infinite;
  /* Far enough apart in time to stay apart in space where they slow down. */
  animation-delay: calc(var(--i) * 0.26s);
}

.lane::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  width: 0.35rem;
  height: 0.35rem;
  border-radius: 50%;
  background: hsl(var(--primary));
}

/* Fast, slow, fast: a curve steep at both ends and shallow in the middle (about
   a third of the average speed there — slow, but still moving). The crossing
   takes 72% of the cycle; the rest is a pause before the dot comes round
   again. (-0.35rem: the dot's own width, so it ends on the track's right edge
   rather than past it.) */
@keyframes dots-cross {
  0% {
    transform: translateX(0);
    animation-timing-function: cubic-bezier(0.15, 0.7, 0.85, 0.3);
  }
  72%,
  100% {
    transform: translateX(calc(100% - 0.35rem));
  }
}

@keyframes dots-fade {
  0% {
    opacity: 0;
  }
  8% {
    opacity: 1;
  }
  64% {
    opacity: 1;
  }
  72%,
  100% {
    opacity: 0;
  }
}

/* No motion asked for: the dots simply stand in a row. */
@media (prefers-reduced-motion: reduce) {
  .track {
    display: flex;
    justify-content: center;
    gap: 0.5rem;
    width: auto;
    overflow: visible;
  }

  .lane {
    position: static;
    width: 0.35rem;
    height: 0.35rem;
    opacity: 0.7;
    animation: none;
  }

  .lane::before {
    position: static;
    display: block;
  }
}

/* Said, not shown: what is loading, for a screen reader. */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
