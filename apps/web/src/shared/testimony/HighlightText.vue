<script lang="ts">
import { defineComponent, h, type VNode } from "vue";

/**
 * Renders `text`, wrapping every case-insensitive occurrence of `query` in a
 * <mark class="hl">. Uses a render function (not v-html) so the user-supplied
 * query can never inject markup. Emits an inline fragment, so it drops straight
 * into a span/blockquote without adding wrapper elements.
 */
export default defineComponent({
  name: "HighlightText",
  props: {
    text: { type: String, required: true },
    query: { type: String, default: "" },
  },
  setup(props) {
    return () => {
      const text = props.text;
      const q = props.query.trim();
      if (!q) return text;

      const lower = text.toLowerCase();
      const lowerQ = q.toLowerCase();
      const out: (string | VNode)[] = [];
      let i = 0;
      for (;;) {
        const idx = lower.indexOf(lowerQ, i);
        if (idx === -1) {
          out.push(text.slice(i));
          break;
        }
        if (idx > i) out.push(text.slice(i, idx));
        out.push(h("mark", { class: "hl" }, text.slice(idx, idx + q.length)));
        i = idx + q.length;
      }
      return out;
    };
  },
});
</script>
