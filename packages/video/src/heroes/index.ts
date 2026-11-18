import { HERO_NAMES, type HeroName } from "@bytereel/pipeline/planning/hero-catalog";
import { GENERIC_HEROES } from "./generic";
import type { HeroArt } from "./kit";
import { MONEY_HEROES } from "./money";
import { NATURE_HEROES } from "./nature";
import { PLACES_HEROES } from "./places";
import { SCIENCE_HEROES } from "./science";
import { TECH_HEROES } from "./tech";

/**
 * The hero library: artwork for every name in the hero catalog
 * (packages/pipeline/src/planning/hero-catalog.ts holds the names, titles and keywords).
 * The type check makes sure no catalog hero is missing its drawing.
 */
export const HERO_ART: Record<HeroName, HeroArt> = {
  ...NATURE_HEROES,
  ...MONEY_HEROES,
  ...TECH_HEROES,
  ...SCIENCE_HEROES,
  ...PLACES_HEROES,
  ...GENERIC_HEROES,
};

export { HERO_NAMES };
export { HeroDefs, type HeroArt, type HeroProps } from "./kit";
