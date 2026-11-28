<script setup lang="ts">
import { computed } from "vue";
import { parseAnswers } from "@ac/shared";
import { formatTestimonyText } from "@/shared/testimony/text";
import HighlightText from "@/shared/testimony/HighlightText.vue";

// A testimony's text. One sent through the "Témoigner" form is its answers,
// each under its question; any other is shown as it is.
//
// The text elements carry `textClass` (the page's own quotation style — the
// page reaches them with :deep()); the questions are styled here, and what
// keeps any text inside its block: a run without a space breaks where the line
// ends, and the words sit in a span of their own, so that their writing
// direction cannot reach the quotation marks the page draws around them.

const props = withDefaults(
  defineProps<{
    content: string;
    highlight?: string;
    /** Paragraph breaks after sentences (formatTestimonyText). */
    format?: boolean;
    as?: "blockquote" | "p";
    textClass?: string;
  }>(),
  { highlight: "", format: false, as: "blockquote", textClass: "t-quote" },
);

const shape = (text: string) => (props.format ? formatTestimonyText(text) : text);

const answers = computed(() => parseAnswers(props.content));
</script>

<template>
  <div v-if="answers" class="t-answers">
    <div v-for="a in answers" :key="a.question" class="t-answer">
      <p class="t-question">{{ a.question }}</p>
      <component :is="as" :class="[textClass, 't-text']">
        <span class="t-words"><HighlightText :text="shape(a.answer)" :query="highlight" /></span>
      </component>
    </div>
  </div>
  <component :is="as" v-else :class="[textClass, 't-text']">
    <span class="t-words"><HighlightText :text="shape(content)" :query="highlight" /></span>
  </component>
</template>

<style scoped>
.t-text {
  overflow-wrap: anywhere;
}

.t-words {
  unicode-bidi: isolate;
}

.t-answers {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.t-answer {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.t-question {
  margin: 0;
  font-size: var(--text-caption);
  font-weight: 600;
  letter-spacing: 0.01em;
  color: hsl(var(--muted-foreground));
}
</style>
