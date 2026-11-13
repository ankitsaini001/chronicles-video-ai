import { UserMenu } from "@/components/auth/UserMenu";
import { Logo } from "@/components/Logo";
import { cn } from "@/components/ui";
import type { Usage } from "@/lib/account/me";
import { SITE } from "@/lib/site";
import { AppNav } from "./AppNav";
import { NotificationsBell } from "./NotificationsBell";

// The top bar on every signed-in page (Stitch "My videos" / "My videos (empty)"):
// logo · My videos · Settings (soon) ········ Videos today: 0 of 3 · bell · avatar menu.
// Phones: the top row keeps logo, bell and avatar; My videos, Settings and a shorter usage pill
// move to a second row (from the md breakpoint everything fits on one row).

type AppHeaderProps = {
  user: { name: string; email: string };
  videosToday: Usage;
  unreadNotifications: number;
};

function UsagePill({ usage, short = false, className }: { usage: Usage; short?: boolean; className?: string }) {
  return (
    <p className={cn("items-center rounded-full border border-line bg-surface-2 px-3 py-1.5 font-mono text-[11px] leading-none uppercase tracking-wider whitespace-nowrap text-muted", className)}>
      {short ? (
        <>
          <span className="sr-only">Videos </span>Today: {usage.used} of {usage.limit}
        </>
      ) : (
        <>
          Videos today: {usage.used} of {usage.limit}
        </>
      )}
    </p>
  );
}

export function AppHeader({ user, videosToday, unreadNotifications }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-surface">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-8">
          <Logo href="/dashboard" label={`${SITE.name}: My videos`} />
          <AppNav className="hidden md:flex" />
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-3">
          <UsagePill usage={videosToday} className="hidden md:inline-flex" />
          <NotificationsBell unread={unreadNotifications} />
          <UserMenu variant="avatar" name={user.name} email={user.email} />
        </div>
      </div>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 px-4 sm:px-6 md:hidden">
        <AppNav compact className="flex" />
        <UsagePill usage={videosToday} short className="my-2 inline-flex" />
      </div>
    </header>
  );
}
