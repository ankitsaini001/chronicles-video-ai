"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui";

// "My videos" and "Settings" in the app top bar (Stitch "My videos"). The active item gets the
// amber underline. A client component because layouts don't re-render on navigation, so only
// usePathname knows the current page.
// Settings arrives in F33: until then it is plain text with a "Soon" badge (no link, no 404).

/** Pages that belong to "My videos": the list itself and everything inside a project. */
export function isMyVideosPath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname === "/projects" || pathname.startsWith("/projects/");
}

export function AppNav({ className, compact = false }: { className?: string; compact?: boolean }) {
  const pathname = usePathname();
  const active = isMyVideosPath(pathname);
  const height = compact ? "h-11" : "h-16";

  return (
    <nav aria-label="Main" className={cn("items-center gap-6", className)}>
      <Link
        href="/dashboard"
        aria-current={pathname === "/dashboard" ? "page" : undefined}
        className={cn(
          height,
          "-mb-px flex items-center border-b-2 text-[15px] transition-colors",
          active ? "border-amber font-bold text-amber" : "border-transparent text-muted hover:text-text",
        )}
      >
        My videos
      </Link>
      <span className={cn(height, "flex cursor-default items-center gap-2 border-b-2 border-transparent text-[15px] text-muted/70")}>
        Settings
        <span className="rounded-full border border-line px-1.5 py-0.5 font-mono text-[10px] leading-none uppercase tracking-wider text-muted">
          Soon
        </span>
      </span>
    </nav>
  );
}
