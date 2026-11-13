import type { Metadata } from "next";
import Link from "next/link";
import { Button, cn, PlayIcon } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";

// "My videos" (Stitch "ByteReel — My videos (empty)"). Sign-up and log in land here.
// F11 shows the first-visit empty state; the project cards arrive in F21.
// The tabs are links (?tab=ready …), so they work without JavaScript, survive a reload and the
// browser's Back button. An unknown tab shows Drafts.
// One primary button per screen (BRAND §2): the design's extra "+ New video" button next to the
// title is left out while there are no videos; it comes with the cards in F21.

export const metadata: Metadata = { title: "My videos" };

const DASHBOARD_TABS = [
  { id: "drafts", label: "Drafts", title: "No videos yet", text: "Turn any topic into a ready-to-post Reel in a few minutes." },
  { id: "ready", label: "Ready", title: "Nothing ready yet", text: "Finished videos you haven't posted yet will show up here." },
  { id: "scheduled", label: "Scheduled", title: "Nothing scheduled", text: "Videos you schedule for Instagram will show up here." },
  { id: "published", label: "Published", title: "Nothing published yet", text: "Videos you post to Instagram will show up here." },
] as const;

type TabId = (typeof DASHBOARD_TABS)[number]["id"];

function pickTab(value: string | string[] | undefined): (typeof DASHBOARD_TABS)[number] {
  const wanted = Array.isArray(value) ? value[0] : value;
  return DASHBOARD_TABS.find((t) => t.id === wanted) ?? DASHBOARD_TABS[0];
}

function tabHref(id: TabId): string {
  return id === "drafts" ? "/dashboard" : `/dashboard?tab=${id}`;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  // The layout checks too, but layouts don't re-run on every navigation (see app/(app)/layout.tsx).
  await requireUser();
  const tab = pickTab((await searchParams).tab);

  return (
    <>
      <h1 className="mb-6 font-display text-3xl font-extrabold tracking-tight text-text sm:text-4xl">My videos</h1>

      <nav aria-label="Filter videos" className="mb-10 -mx-4 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:mb-12 sm:px-0">
        <ul className="flex min-w-max items-center gap-1 sm:gap-2">
          {DASHBOARD_TABS.map((t) => {
            const current = t.id === tab.id;
            return (
              <li key={t.id}>
                <Link
                  href={tabHref(t.id)}
                  aria-current={current ? "page" : undefined}
                  scroll={false}
                  className={cn(
                    "-mb-px flex min-h-11 items-center border-b-2 px-3 text-[15px] transition-colors sm:px-4",
                    current ? "border-amber font-bold text-amber" : "border-transparent text-muted hover:text-text",
                  )}
                >
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <section aria-labelledby="empty-title" className="mx-auto flex max-w-lg flex-1 flex-col items-center justify-center pb-8 text-center">
        {/* A phone-shaped (9:16) outline with a glowing play button. */}
        <div
          aria-hidden="true"
          className="mb-8 flex h-64 w-36 items-center justify-center rounded-[28px] border-2 border-dashed border-amber/25 bg-surface shadow-[0_0_50px_#f5a5241f] sm:h-80 sm:w-44"
        >
          <div className="relative flex items-center justify-center">
            <div className="absolute inset-0 rounded-full bg-amber/20 blur-xl" />
            <div className="relative flex size-16 items-center justify-center rounded-full border border-amber/40 bg-surface-2 shadow-[0_0_25px_#f5a52459]">
              <PlayIcon className="ml-0.5 size-6 text-amber" />
            </div>
          </div>
        </div>
        <h2 id="empty-title" className="mb-3 font-display text-2xl font-bold text-text">
          {tab.title}
        </h2>
        <p className="mb-8 max-w-sm text-base leading-relaxed text-muted">{tab.text}</p>
        <Button href="/projects/new">Create your first reel</Button>
      </section>
    </>
  );
}
