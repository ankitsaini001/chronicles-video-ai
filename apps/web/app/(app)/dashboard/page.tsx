import { getDb, hasLibraryProjects, listProjects, PAGE_LIMITS, readDbConfig, type LibraryTab } from "@bytereel/db";
import type { Metadata } from "next";
import Link from "next/link";
import { FirstVisit } from "@/components/dashboard/FirstVisit";
import { ProjectList } from "@/components/dashboard/ProjectList";
import { Button, cn } from "@/components/ui";
import { getMe } from "@/lib/account/me";
import { requireUser } from "@/lib/auth/session";

// "My videos" (F21; Stitch "My videos" and "My videos (empty)"). Sign-up and log in land here.
// - No projects in My videos yet (none, or all archived): the first-visit page (how it works, your
//   limits, "Create your first video"). No tabs there: there is nothing to filter.
// - Otherwise: "+ New video", the tabs and the cards of the chosen tab, newest-updated first. The
//   first page comes from the same function as C1 (GET /api/v1/projects); "Load more" calls C1.
//   An empty tab gets a short friendly line.
// The tabs are links (?tab=ready …), so they work without JavaScript, survive a reload and the
// browser's Back button. An unknown tab shows Drafts. There is no Archived tab (founder, F21).

export const metadata: Metadata = { title: "My videos" };

const DASHBOARD_TABS = [
  { id: "drafts", label: "Drafts", empty: "No drafts right now. Start a new video any time." },
  { id: "ready", label: "Ready", empty: "Nothing ready yet. Finished videos you haven't posted will show up here." },
  { id: "scheduled", label: "Scheduled", empty: "Nothing scheduled. Videos you schedule for Instagram will show up here." },
  { id: "published", label: "Published", empty: "Nothing published yet. Videos you post to Instagram will show up here." },
] as const satisfies readonly { id: LibraryTab; label: string; empty: string }[];

type DashboardTab = (typeof DASHBOARD_TABS)[number];

function pickTab(value: string | string[] | undefined): DashboardTab {
  const wanted = Array.isArray(value) ? value[0] : value;
  return DASHBOARD_TABS.find((t) => t.id === wanted) ?? DASHBOARD_TABS[0];
}

function tabHref(id: LibraryTab): string {
  return id === "drafts" ? "/dashboard" : `/dashboard?tab=${id}`;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  // The layout checks too, but layouts don't re-run on every navigation (see app/(app)/layout.tsx).
  const user = await requireUser();
  const tab = pickTab((await searchParams).tab);
  const settings = readDbConfig(process.env);
  if (!settings.ok) throw new Error(settings.problems.join(" "));
  const db = getDb(settings.config);
  const [hasProjects, page] = await Promise.all([hasLibraryProjects(db, user.id), listProjects(db, user.id, { tab: tab.id, limit: PAGE_LIMITS.default, cursor: null })]);

  if (!hasProjects) return <FirstVisit me={await getMe(user)} />;

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-display text-[28px] font-extrabold tracking-tight whitespace-nowrap text-text sm:text-4xl">My videos</h1>
        <Button href="/projects/new" className="shrink-0">
          + New video
        </Button>
      </div>

      {/* No scroll box here: the four tabs fit even at 320px (tighter padding and text on phones). */}
      <nav aria-label="Filter videos" className="mb-6 border-b border-line sm:mb-8">
        <ul className="flex items-center justify-between sm:justify-start sm:gap-2">
          {DASHBOARD_TABS.map((t) => {
            const current = t.id === tab.id;
            return (
              <li key={t.id}>
                <Link
                  href={tabHref(t.id)}
                  aria-current={current ? "page" : undefined}
                  scroll={false}
                  className={cn(
                    "-mb-px flex min-h-11 items-center whitespace-nowrap border-b-2 px-2 text-sm transition-colors sm:px-4 sm:text-[15px]",
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

      <ProjectList key={tab.id} tab={tab.id} initialItems={page.items} initialCursor={page.nextCursor} now={new Date().toISOString()} timeZone={user.timezone} emptyText={tab.empty} />
    </>
  );
}
