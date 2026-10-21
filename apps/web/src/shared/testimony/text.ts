/**
 * Improve testimony readability: add paragraph breaks after sentences
 * (ported from the old app's formatText).
 */
export function formatTestimonyText(text: string): string {
  if (!text) return "";
  return text.replace(/\.(\s+)([A-ZÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ])/g, ".\n\n$2").trim();
}
