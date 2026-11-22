"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiSend } from "@/components/storyboard/client";
import { Note } from "@/components/storyboard/Note";
import { Button, PlainLinkButton } from "@/components/ui";
import { INSTAGRAM_MESSAGES, type InstagramNotice } from "@/lib/instagram/messages";

// ④ Publish, the Instagram card (F28; Stitch "Step 4 Connect Instagram", decision 1).
// Not connected: "Connect your Instagram", the three promises and Connect Instagram (a real page
// load to G2, which sends the creator to Instagram's own login page). Connected: "Publishing to
// @username" with the picture, Disconnect (G4: the token is deleted at once) and "Publishing comes
// next" until publishing itself arrives (F30). A result from Instagram (connected, personal account,
// cancelled, in use, expired) shows as one plain line on top.

export type CardConnection = { username: string; profilePictureUrl: string | null; status: "active" | "expired" | "error" };

const PROMISES = ["Publish now or schedule for later", "Nothing is posted without your approval", "Disconnect anytime"];

function Check() {
  return (
    <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full border border-amber/40 bg-surface-2">
      <svg viewBox="0 0 24 24" className="size-3 fill-none stroke-amber" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  );
}

function InstagramIcon() {
  return (
    <div className="relative mb-6 flex size-16 items-center justify-center rounded-[14px] border border-amber/30 bg-surface-2 shadow-[0_0_20px_rgba(245,165,36,0.15)]">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-8 fill-none stroke-amber" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
        <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
        <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
      </svg>
    </div>
  );
}

export function InstagramCard({ projectId, connection, notice }: { projectId: string; connection: CardConnection | null; notice: InstagramNotice | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<InstagramNotice | null>(notice);
  const connectHref = `/api/v1/instagram/connect?returnTo=${encodeURIComponent(`publish:${projectId}`)}`;
  const active = connection?.status === "active" ? connection : null;

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setShown(null);
    const answer = await apiSend("DELETE", "/api/v1/instagram/connection");
    setBusy(false);
    // Already disconnected (e.g. in another tab) is the same result for the creator.
    if (!answer.ok && answer.status !== 404) return setShown({ tone: "problem", text: answer.message });
    setShown({ tone: "success", text: INSTAGRAM_MESSAGES.disconnected });
    // Drop ?instagram=connected from the address and re-read the connection on the server.
    router.replace(`/projects/${projectId}/publish`);
    router.refresh();
  }

  const noticeLine = shown && (
    <div role={shown.tone === "problem" ? "alert" : "status"} data-testid="instagram-notice" className="mb-6 w-full max-w-md text-left">
      {shown.tone === "problem" ? (
        <Note tone="problem" label="Instagram: ">
          {shown.text}
        </Note>
      ) : (
        <p className="rounded-xl border border-success/25 bg-success-bg px-3.5 py-2.5 text-xs text-success">{shown.text}</p>
      )}
    </div>
  );

  if (active) {
    return (
      <section aria-labelledby="instagram-heading" data-testid="instagram-connected" className="flex w-full max-w-xl flex-col items-center rounded-2xl border border-line bg-surface p-6 text-center shadow-card sm:p-10">
        {noticeLine}
        {active.profilePictureUrl ? (
          // Instagram's own picture address (its CDN): a plain <img>, no referrer sent.
          <img src={active.profilePictureUrl} alt="" referrerPolicy="no-referrer" className="mb-6 size-16 rounded-full border border-amber/30 object-cover" />
        ) : (
          <InstagramIcon />
        )}
        <h1 id="instagram-heading" className="mb-3 font-display text-2xl font-extrabold tracking-tight break-words text-text sm:text-3xl">
          Publishing to <span data-testid="instagram-username">@{active.username}</span>
        </h1>
        <p className="mb-8 max-w-md text-sm leading-relaxed text-muted">Your Instagram is connected. Publishing comes next: soon you&apos;ll post or schedule this video from here, always after you approve it.</p>
        <Button type="button" variant="secondary" onClick={() => void disconnect()} disabled={busy} data-testid="instagram-disconnect">
          {busy ? "Disconnecting…" : "Disconnect"}
        </Button>
      </section>
    );
  }

  return (
    <section aria-labelledby="instagram-heading" data-testid="instagram-connect" className="flex w-full max-w-xl flex-col items-center rounded-2xl border border-line bg-surface p-6 text-center shadow-card sm:p-10">
      {noticeLine}
      {/* An expired/broken connection: always said, also next to another notice. */}
      {connection && (
        <div className="mb-6 w-full max-w-md text-left">
          <Note tone="warning">{INSTAGRAM_MESSAGES.needsReconnect}</Note>
        </div>
      )}
      <InstagramIcon />
      <h1 id="instagram-heading" className="mb-4 font-display text-3xl font-extrabold tracking-tight text-text sm:text-4xl">
        Connect your Instagram
      </h1>
      <p className="mb-8 max-w-md text-sm leading-relaxed text-muted sm:text-base">
        To publish, connect an Instagram Creator or Business account. You&apos;ll log in on Instagram. We never see your password.
      </p>
      <ul className="mb-9 w-full max-w-md space-y-3.5 text-left">
        {PROMISES.map((text) => (
          <li key={text} className="flex items-center gap-3.5 text-sm text-text">
            <Check />
            {text}
          </li>
        ))}
      </ul>
      <PlainLinkButton href={connectHref} fullWidth className="mb-5 max-w-md" data-testid="instagram-connect-button">
        Connect Instagram
      </PlainLinkButton>
      <p className="max-w-sm text-xs leading-normal text-muted">Have a personal account? Switch it to a Creator account in the Instagram app first. You can always download your video.</p>
    </section>
  );
}
