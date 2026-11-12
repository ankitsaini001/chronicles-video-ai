import type { Metadata } from "next";
import type { ReactNode } from "react";
import { fontVariables } from "./fonts";
import "./globals.css";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  // Pages set a short title ("Log in") and get "Log in · <product name>".
  title: { default: SITE.name, template: `%s · ${SITE.name}` },
  description: "Turn any topic into a ready-to-post explainer Reel.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // data-scroll-behavior: Next 16 then turns smooth scrolling off during page changes.
    <html lang="en" className={fontVariables} data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
