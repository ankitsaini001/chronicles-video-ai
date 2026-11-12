// Brand fonts (docs/BRAND.md §3), self-hosted by next/font: the files are downloaded at build time
// and served from our own domain, so visitors' browsers never contact Google.
import { Exo_2, JetBrains_Mono, Noto_Sans_Devanagari, Ubuntu } from "next/font/google";

/** Display / headings. */
export const exo2 = Exo_2({
  subsets: ["latin"],
  weight: ["700", "800"],
  variable: "--font-exo2",
  display: "swap",
});

/** Body / UI. */
export const ubuntu = Ubuntu({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-ubuntu",
  display: "swap",
});

/** Hindi (Devanagari): used automatically for Devanagari characters (fallback in every font stack). */
export const notoDevanagari = Noto_Sans_Devanagari({
  subsets: ["devanagari"],
  weight: ["500", "600", "700"], // 700: bold Hindi headings and tiles (no fake bold)
  variable: "--font-devanagari",
  display: "swap",
});

/** Labels / data (small uppercase labels, step numbers, durations). */
export const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const fontVariables = [exo2.variable, ubuntu.variable, notoDevanagari.variable, jetbrainsMono.variable].join(" ");
