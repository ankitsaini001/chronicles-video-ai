import type { Metadata } from "next";
import { Hero } from "@/components/home/Hero";
import { Examples, Faq, FinalCta, HowItWorks, Languages, WhyByteReel } from "@/components/home/sections";
import { SiteFooter } from "@/components/home/SiteFooter";
import { SiteHeader } from "@/components/home/SiteHeader";

// Public home page (F03), built from the approved Stitch screen "ByteReel — Home v2"
// (docs/design/stitch/home.html).

export const metadata: Metadata = {
  title: "ByteReel · Turn any topic into a ready-to-post Reel",
  description:
    "Type an idea or paste your notes. ByteReel writes the script, animates every concept and adds a natural voice in English, Hindi or Hinglish.",
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
        <WhyByteReel />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
