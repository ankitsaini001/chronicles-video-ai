// Site-wide brand settings. EVERY place the web app shows the product name reads it from here,
// so renaming the product is a change to this file (plus the checklist in docs/BRAND.md
// "Renaming the product" for things outside the web app: domain, Meta app, package names, docs).

export const SITE = {
  /** Product name as shown in text, titles and alt labels. */
  name: "ByteReel",
  /** The logo wordmark: `plain` in the text colour, `accent` in gold. Together they spell `name`. */
  wordmark: { plain: "Byte", accent: "Reel" },
  /** Endorsement line under the logo and in the footer. */
  endorsement: "by Tech Byte Chronicles",
  /** Year shown in the footer copyright. */
  copyrightYear: 2026,
  /**
   * Where "Contact us" emails go.
   * TEMPORARY: a dummy testing address (example.com is reserved for examples, so mail goes
   * nowhere). Replace with the real address before launch (tracked in F38).
   */
  contactEmail: "contact@example.com",
} as const;
