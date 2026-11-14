// Content-Disposition for downloads (ARCHITECTURE §9): `attachment; filename="<safe ASCII>"`,
// plus an RFC 5987 `filename*` with the real UTF-8 name when it isn't plain ASCII (Hindi titles).

const MAX_NAME_CHARS = 120;
const FALLBACK_BASE = "download";
const EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/**
 * Same as String.prototype.toWellFormed() (ES2024, not in our TypeScript lib): a lone surrogate
 * becomes U+FFFD. Without this, encodeURIComponent throws on a broken title.
 */
function toWellFormed(value: string): string {
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** Remove control characters and path separators; keep the visible name. */
function cleanName(name: string): string {
  const cleaned = toWellFormed(name)
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "")
    .replace(/[/\\]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  const chars = [...cleaned];
  if (chars.length <= MAX_NAME_CHARS) return cleaned;
  // Keep the extension when shortening.
  const ext = EXTENSION.exec(cleaned)?.[0] ?? "";
  return [...cleaned.slice(0, cleaned.length - ext.length)].slice(0, MAX_NAME_CHARS - ext.length).join("").trim() + ext;
}

/** A plain-ASCII version for old browsers: accents dropped, other non-ASCII removed, quotes replaced. */
function asciiFallback(name: string): string {
  const ext = EXTENSION.exec(name)?.[0] ?? "";
  const base = name
    .slice(0, name.length - ext.length)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\%;]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (base === "" || /^[\s._-]*$/.test(base) ? FALLBACK_BASE : base) + ext;
}

/** RFC 5987 value-chars: encodeURIComponent leaves ' ( ) * unescaped, which must be escaped here. */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function attachmentContentDisposition(filename: string): string {
  const name = cleanName(filename) || FALLBACK_BASE;
  const fallback = asciiFallback(name);
  if (name === fallback) return `attachment; filename="${fallback}"`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987(name)}`;
}
