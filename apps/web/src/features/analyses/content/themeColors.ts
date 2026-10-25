// The themes' colours: one per theme, the same in every territory, and its
// pastel for the parts not picked.
import type { AuditionTheme } from "@ac/shared";

/**
 * One colour per theme, the same in every territory, so that a reader learns
 * them. Sixteen vivid hues around the wheel, each as saturated as sRGB allows
 * at its hue and lightness (OKLCH L 0.60–0.72, C up to 0.27, in the comments):
 * the pinks, the red, the green, the blue, the violets and the magentas reach
 * C 0.20–0.27; the orange, the ochre, the olive, the teals and the cyan blues
 * stop at C 0.11–0.16, all sRGB holds at that lightness — lighter, they would
 * wash out on a pale map; darker, they would turn muddy.
 * Each theme keeps its hue of before within 15°, so that a reader who learned
 * them still knows them; set so that the themes often large together, and
 * neighbours in the ring (largest first), stand furthest apart: Démocratie,
 * Justice sociale, Services publics, Fiscalité, Emploi, Pouvoir d'achat,
 * Environnement, Santé, Retraites keep OKLab ΔE 13 or more between any two of
 * them, and any two of the sixteen 10.8 or more. Colour alone cannot carry
 * sixteen categories for every eye: under protanopia or deuteranopia about a
 * dozen pairs fall under ΔE 5 — Santé / Environnement the one most often large
 * together, then Démocratie / Guerre, Éducation / Guerre, Médias / Guerre,
 * Éducation / Médias, Justice sociale / Immigration, Pouvoir d'achat / Culture,
 * Sécurité / Fiscalité… — the gaps between parts and the label named on hover,
 * focus or pick are what tell them apart, never the colour alone (the palette
 * before had more such pairs). Plain sRGB hex: every browser draws them the same, and
 * they read on a light map and a dark one alike (each part stands raised, its
 * walls a shade darker: they keep it off a pale ground).
 */
export const THEME_COLORS: Record<AuditionTheme, string> = {
  "Justice sociale et inégalités": "#fe619c", // oklch(0.71 0.197 0)
  Logement: "#e90d71", // oklch(0.604 0.239 4)
  "Santé et accès aux soins": "#fe3209", // oklch(0.644 0.24 32)
  "Emploi et conditions de travail": "#e58d10", // oklch(0.719 0.157 66)
  Fiscalité: "#a3780a", // oklch(0.6 0.121 83)
  "Sécurité et police": "#62910a", // oklch(0.6 0.156 129)
  "Environnement et écologie": "#1db80c", // oklch(0.681 0.225 142)
  Immigration: "#10bf92", // oklch(0.716 0.143 168)
  Retraites: "#0c957b", // oklch(0.599 0.112 174)
  "Services publics": "#14b4e9", // oklch(0.72 0.139 229)
  "Culture et loisirs": "#0f90bd", // oklch(0.612 0.119 230)
  "Guerre et géopolitique": "#0f82fd", // oklch(0.619 0.205 256)
  "Démocratie et institutions": "#7a60fd", // oklch(0.602 0.223 285)
  Éducation: "#c56efd", // oklch(0.695 0.213 310)
  "Pouvoir d'achat et inflation": "#d30ec2", // oklch(0.601 0.265 333)
  "Médias et information": "#fd47e9", // oklch(0.714 0.27 333)
};

/**
 * Each theme's colour as a pastel, for the parts NOT picked (one always is):
 * the same hue, light and soft (OKLCH C 0.065, less where sRGB stops it), its
 * lightness 0.85–0.91 after the colour's own (L 0.85 + (L − 0.60) / 2), so
 * that the pairs of a hue told apart by lightness alone (Pouvoir d'achat /
 * Médias, Culture / Services publics, Retraites / Immigration, Logement /
 * Justice sociale) stay apart as pastels too. Opaque: the picked part, vivid,
 * stands out of them; they keep the ring whole. On a pale map their darker
 * walls outline them; on a dark one they stand out as they are.
 */
export const THEME_PASTELS: Record<AuditionTheme, string> = {
  "Justice sociale et inégalités": "#fed2de", // oklch(0.905 0.052 360)
  Logement: "#f4bdc9", // oklch(0.851 0.065 4)
  "Santé et accès aux soins": "#fdc6ba", // oklch(0.872 0.065 32)
  "Emploi et conditions de travail": "#fedab7", // oklch(0.91 0.061 66)
  Fiscalité: "#e3cb9e", // oklch(0.851 0.065 83)
  "Sécurité et police": "#c1d7aa", // oklch(0.851 0.065 129)
  "Environnement et écologie": "#c3e7bf", // oklch(0.891 0.066 142)
  Immigration: "#b7efd9", // oklch(0.908 0.065 169)
  Retraites: "#a2dcca", // oklch(0.85 0.065 174)
  "Services publics": "#bee9fe", // oklch(0.91 0.053 229)
  "Culture et loisirs": "#a4d8f2", // oklch(0.855 0.065 230)
  "Guerre et géopolitique": "#b5d3fc", // oklch(0.859 0.066 256)
  "Démocratie et institutions": "#c9c9f8", // oklch(0.851 0.065 285)
  Éducation: "#ead2fe", // oklch(0.897 0.065 310)
  "Pouvoir d'achat et inflation": "#e9bfe0", // oklch(0.851 0.064 334)
  "Médias et information": "#fcd1f3", // oklch(0.907 0.065 333)
};
