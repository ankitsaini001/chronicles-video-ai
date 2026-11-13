"use client";

import { BRAINSTORM_SUBJECT_LIMITS, cleanIdeaText } from "@bytereel/db/idea-text";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button, cn } from "@/components/ui";
import type { Language } from "@/lib/auth/session";

// ① Idea "✨ Brainstorm with AI" + "IDEAS FROM AI" (Stitch "Step 1 Idea", PRD §6.1, API.md C7; F14).
// A secondary pill opens a small subject box; "Get ideas" sends C7 POST /api/v1/brainstorm with the
// subject and the CURRENTLY chosen language, and shows the 5 ideas (title, hook, angle). One click
// on an idea hands it to the Idea form (onPick), which fills the box and sends it to C2 as
// `inputType: "brainstorm"`. Ideas are shown only for the language they were made in: change the
// Language chip and the list hides (press Get ideas again for the new language).
// Busy, refused and limit answers are shown in plain words inside the panel; the rest of the form
// keeps working while the AI thinks. Results and status are announced (aria-live).
// No Idempotency-Key: C7 saves nothing (API.md §6).

export type BrainstormIdea = { id: string; title: string; hook: string; angle: string };
export type PickedIdea = { subject: string; idea: BrainstormIdea };

type BrainstormPanelProps = {
  language: Language;
  /** Smart default for the subject: the idea box's text, when it is short enough. */
  ideaText: string;
  /** The idea currently used in the box, to mark it as chosen (ids repeat in every new list). */
  picked: BrainstormIdea | null;
  onPick: (picked: PickedIdea) => void;
  timezone: string;
  disabled?: boolean;
};

type ApiErrorBody = { error?: { code?: string; message?: string; details?: { retryAfterSeconds?: number; resetsAt?: string } } };
type Result = { subject: string; language: Language; ideas: BrainstormIdea[] };

/** The server stops at 30 s; this is only a safety net if the network hangs. */
const CLIENT_TIMEOUT_MS = 45_000;

const MESSAGES = {
  SUBJECT: `Type a subject of ${BRAINSTORM_SUBJECT_LIMITS.min} to ${BRAINSTORM_SUBJECT_LIMITS.max} characters, e.g. "Indian monsoon".`,
  OFFLINE: "Couldn't reach the server. Check your internet connection and try again.",
  BUSY: "Our AI is very busy right now. Please try again in a few minutes.",
  INTERNAL: "Something went wrong on our side. Please try again.",
} as const;

function minutesText(seconds: number | undefined): string {
  const minutes = Math.max(1, Math.ceil((seconds ?? 60) / 60));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function resetText(resetsAt: string | undefined, timezone: string): string {
  if (!resetsAt) return "";
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return ` You can brainstorm again from ${new Intl.DateTimeFormat("en-IN", { timeZone: timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date)}.`;
  } catch {
    return "";
  }
}

export function BrainstormPanel({ language, ideaText, picked, onPick, timezone, disabled = false }: BrainstormPanelProps) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [subjectError, setSubjectError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const ids = useId();
  const panelId = `${ids}-panel`;
  const subjectId = `${ids}-subject`;

  // Leaving the page cancels a brainstorm that is still running.
  useEffect(() => () => inFlight.current?.abort(), []);

  function openPanel() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (subject === "") {
      const fromBox = cleanIdeaText(ideaText);
      if (fromBox.length >= BRAINSTORM_SUBJECT_LIMITS.min && fromBox.length <= BRAINSTORM_SUBJECT_LIMITS.max) setSubject(fromBox);
    }
    // After the box is rendered.
    requestAnimationFrame(() => subjectRef.current?.focus());
  }

  async function getIdeas() {
    if (loading || disabled) return;
    const clean = cleanIdeaText(subject);
    if (clean.length < BRAINSTORM_SUBJECT_LIMITS.min || clean.length > BRAINSTORM_SUBJECT_LIMITS.max) {
      setSubjectError(MESSAGES.SUBJECT);
      subjectRef.current?.focus();
      return;
    }
    setSubjectError(null);
    setError(null);
    setLoading(true);
    const controller = new AbortController();
    inFlight.current = controller;
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch("/api/v1/brainstorm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ subject: clean, language }),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      if (inFlight.current !== controller) return; // the page was left
      inFlight.current = null;
      setLoading(false);
      setError(controller.signal.aborted ? MESSAGES.BUSY : MESSAGES.OFFLINE);
      return;
    }
    clearTimeout(timer);
    inFlight.current = null;
    const json = (await response.json().catch(() => ({}))) as ApiErrorBody & Partial<Result>;
    setLoading(false);

    if (response.ok && Array.isArray(json.ideas) && typeof json.subject === "string" && json.language) {
      setResult({ subject: json.subject, language: json.language, ideas: json.ideas });
      return;
    }
    const code = json.error?.code ?? "";
    switch (code) {
      case "UNAUTHENTICATED":
        window.location.assign("/login");
        return;
      case "INVALID_INPUT":
        setSubjectError(MESSAGES.SUBJECT);
        subjectRef.current?.focus();
        return;
      case "RATE_LIMITED":
        return setError(`You've asked for ideas 10 times this hour. Please try again in ${minutesText(json.error?.details?.retryAfterSeconds)}.`);
      case "QUOTA_EXCEEDED":
        return setError((json.error?.message ?? "You've used today's brainstorms. Try again tomorrow.") + resetText(json.error?.details?.resetsAt, timezone));
      case "PROVIDER_REJECTED":
        return setError(json.error?.message ?? "We can't suggest ideas for this subject. Please try a different one.");
      case "PROVIDER_BUSY":
        return setError(json.error?.message ?? MESSAGES.BUSY);
      default:
        return setError(response.status >= 500 ? MESSAGES.INTERNAL : (json.error?.message ?? MESSAGES.INTERNAL));
    }
  }

  function onSubjectKey(event: KeyboardEvent<HTMLInputElement>) {
    // Enter asks for ideas; it must not submit the Idea form around this box.
    if (event.key === "Enter") {
      event.preventDefault();
      void getIdeas();
    }
  }

  // Ideas are written in one language; they show only while that language is chosen.
  const ideas = result && result.language === language ? result.ideas : null;
  const status = loading
    ? "Finding 5 ideas. This can take up to 30 seconds."
    : ideas
      ? `${ideas.length} ideas ready. Choose one to use it.`
      : result
        ? "Language changed. Press Get ideas for ideas in the new language."
        : "";

  return (
    <div className="mb-7">
      <Button
        variant="secondary"
        size="sm"
        arrow={false}
        onClick={openPanel}
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
      >
        <span aria-hidden="true" className="mr-2 text-xs">
          ✨
        </span>
        Brainstorm with AI
      </Button>

      <div id={panelId} hidden={!open} className="mt-4 rounded-2xl border border-line bg-surface-2 p-4 sm:p-5">
        <p className="mb-3 font-mono text-xs uppercase tracking-wider text-muted">Ideas from AI</p>
        <label htmlFor={subjectId} className="mb-2 block text-sm font-medium text-text">
          Broad subject
        </label>
        <div className="flex flex-col gap-2.5 sm:flex-row">
          <input
            ref={subjectRef}
            id={subjectId}
            type="text"
            value={subject}
            maxLength={BRAINSTORM_SUBJECT_LIMITS.max * 2}
            onChange={(e) => {
              setSubject(e.target.value);
              if (subjectError) setSubjectError(null);
            }}
            onKeyDown={onSubjectKey}
            disabled={disabled}
            enterKeyHint="search"
            autoComplete="off"
            aria-invalid={subjectError ? true : undefined}
            aria-describedby={subjectError ? `${subjectId}-error` : `${subjectId}-help`}
            placeholder="e.g. Indian monsoon"
            className={cn(
              "min-h-11 w-full min-w-0 flex-1 rounded-full border bg-surface px-4 py-2 text-[15px] text-text placeholder:text-muted/60",
              "focus:border-gold-cream focus:outline-none disabled:opacity-60",
              subjectError ? "border-danger" : "border-line",
            )}
          />
          <Button variant="secondary" size="sm" arrow={false} onClick={() => void getIdeas()} disabled={loading || disabled} aria-busy={loading}>
            {loading ? "Thinking…" : ideas ? "Get new ideas" : "Get ideas"}
          </Button>
        </div>
        {subjectError ? (
          <p id={`${subjectId}-error`} className="mt-2 text-[13px] text-danger">
            {subjectError}
          </p>
        ) : (
          <p id={`${subjectId}-help`} className="mt-2 text-xs text-muted">
            We&apos;ll suggest 5 short video ideas in the language you choose below.
          </p>
        )}

        <p aria-live="polite" className={cn("text-sm text-muted", status && "mt-3")}>
          {status}
        </p>
        <div aria-live="assertive">
          {error && <p className="mt-3 rounded-xl border border-danger/40 bg-danger-bg px-3.5 py-2.5 text-sm text-text">{error}</p>}
        </div>

        {ideas && result && (
          <ul className="mt-3 space-y-2.5" aria-label="Ideas from AI">
            {ideas.map((idea) => {
              const chosen = picked !== null && picked.id === idea.id && picked.title === idea.title && picked.hook === idea.hook;
              return (
                <li key={idea.id}>
                  <button
                    type="button"
                    onClick={() => onPick({ subject: result.subject, idea })}
                    disabled={disabled}
                    aria-pressed={chosen}
                    lang={language === "hi" ? "hi" : undefined}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-cream disabled:opacity-60",
                      chosen ? "border-amber bg-progress-bg" : "border-line hover:border-amber/40 hover:bg-surface",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
                        chosen ? "bg-amber text-on-amber" : "border border-line",
                      )}
                    >
                      {chosen ? "✓" : ""}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm leading-snug font-bold text-text">{idea.title}</span>
                      <span className="mt-1 block text-xs leading-snug text-muted">{idea.hook}</span>
                      <span className="mt-1 block text-xs leading-snug text-muted/80">{idea.angle}</span>
                    </span>
                    <span className={cn("shrink-0 text-xs font-medium", chosen ? "text-amber" : "text-muted")}>{chosen ? "Chosen" : "Use this"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
