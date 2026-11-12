import type { Metadata } from "next";
import { Hero } from "@/components/home/Hero";
import { Examples, Faq, FinalCta, HowItWorks, Languages, WhyUs } from "@/components/home/sections";
import { SiteFooter } from "@/components/home/SiteFooter";
import { SiteHeader } from "@/components/home/SiteHeader";
import { SITE } from "@/lib/site";

// Public home page (F03), built from the Stitch screen "ByteReel — Home Landing Page"
// (docs/design/stitch/home-landing-v1.html), chosen by the founder over "Home v2".

export const metadata: Metadata = {
  title: { absolute: `${SITE.name} · Turn any topic into a ready-to-post Reel` },
  description:
    `Type an idea or paste your notes. ${SITE.name} writes the script, animates every concept and adds a natural voice in English, Hindi or Hinglish.`,
};

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <HowItWorks />
        <Examples />
        <Languages />
        <WhyUs />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
