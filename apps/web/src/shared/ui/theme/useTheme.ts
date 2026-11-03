import { ref } from "vue";

// Single source of truth for the theme. The bootstrap runs here, at module
// evaluation, so the ref can never disagree with the <html> class — reading
// the class from main.ts was racy (static imports evaluate before main.ts's
// body, so this module used to initialize before the class was applied).
const saved = typeof localStorage !== "undefined" ? localStorage.getItem("theme") : null;
// Dark by default. Nothing is stored until the visitor picks a theme (the
// privacy page lists `theme` as a choice they made).
const initialDark = saved ? saved === "dark" : true;
if (typeof document !== "undefined") {
  document.documentElement.classList.toggle("dark", initialDark);
}

const isDark = ref(initialDark);

export function useTheme() {
  function toggle() {
    isDark.value = !isDark.value;
    document.documentElement.classList.toggle("dark", isDark.value);
    localStorage.setItem("theme", isDark.value ? "dark" : "light");
  }

  return { isDark, toggle };
}
