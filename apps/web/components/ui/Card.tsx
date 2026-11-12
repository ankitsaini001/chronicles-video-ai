import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./cn";

// Card from docs/BRAND.md §5: surface background, 1px amber-15% line, 16px radius, soft shadow.
export function Card({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div {...props} className={cn("rounded-2xl border border-line bg-surface p-6 shadow-card", className)} />;
}
