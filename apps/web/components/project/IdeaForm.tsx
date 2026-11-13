"use client";

import { cleanIdeaText, IDEA_MAX_CHARS, IDEA_MIN_CHARS, IDEA_TOPIC_MAX_CHARS, ideaInputType, ideaProblem } from "@bytereel/db/idea-text";
import { useRef, useState, type FormEvent } from "react";
import { Button, ChoiceChips, cn, type ChoiceOption } from "@/components/ui";
import type { Usage } from "@/lib/account/me";
import type { Language, VoiceGender } from "@/lib/auth/session";

// ① Idea (Stitch "Step 1 Idea", PRD §6.1, API.md C2), without Brainstorm (F14) and voice
// previews (F13). One box for a topic or pasted notes (up to 5,000 characters), Language and Voice
// chips (single choices), one primary button: Create storyboard.
// The button sends C2 POST /api/v1/projects with an Idempotency-Key. The same key is sent again
// if the click is repeated with the same idea after a network failure, so a lost answer can never
// create the project twice. Success → the project's page.
// The counter, the limits and the topic/notes choice use the server's own cleaning
// (`@bytereel/db/idea-text`: control characters out, NFC, trim), so the numbers always agree.
// There is no hard 5,000 stop in the box: NFC can make a text longer or shorter, so the box only
// stops at a generous safety size and the counter turns red above 5,000.

const MAX_CHARS = IDEA_MAX_CHARS;
/** Only a safety stop for huge pastes; the real limit is checked on the cleaned text. */
const SAFETY_MAX_LENGTH = 4 * IDEA_MAX_CHARS;

const LANGUAGE_OPTIONS: readonly ChoiceOption<Language>[] = [
  { value: "en", label: "English" },
  {
    value: "hi",
    label: (
      <>
        <span lang="hi">हिंदी</span> Hindi
      </>
    ),
  },
  { value: "hinglish", label: "Hinglish" },
];

const VOICE_OPTIONS: readonly ChoiceOption<VoiceGender>[] = [
  { value: "female", label: "Female voice" },
  { value: "male", label: "Male voice" },
];

const MESSAGES = {
  EMPTY: "Type a topic or paste your notes first.",
  TOO_SHORT: `Please write at least ${IDEA_MIN_CHARS} characters.`,
  TOO_LONG: `Please shorten it to ${IDEA_MAX_CHARS.toLocaleString("en-US")} characters.`,
  OFFLINE: "Couldn't reach the server. Check your internet connection and try again.",
  INTERNAL: "Something went wrong on our side. Please try again.",
} as const;

type IdeaFormProps = {
  defaultLanguage: Language;
  defaultVoiceGender: VoiceGender;
  projectsToday: Usage;
  /** The user's timezone, for the time the daily limit resets. */
  timezone: string;
};

type ApiErrorBody = { error?: { code?: string; message?: string; details?: { issues?: { path?: string; message?: string }[]; resetsAt?: string } } };

/** 32 random hex characters. Works on plain http too (crypto.randomUUID needs https or localhost). */
function newIdempotencyKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function resetTimeText(resetsAt: string | undefined, timezone: string): string {
  if (!resetsAt) return "";
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const time = new Intl.DateTimeFormat("en-IN", { timeZone: timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
    return ` You can create more from ${time}.`;
  } catch {
    return "";
  }
}

export function IdeaForm({ defaultLanguage, defaultVoiceGender, projectsToday, timezone }: IdeaFormProps) {
  const [text, setText] = useState("");
  const [language, setLanguage] = useState<Language>(defaultLanguage);
  const [voiceGender, setVoiceGender] = useState<VoiceGender>(defaultVoiceGender);
  const [textError, setTextError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  /** The key of the last click that got no clear answer, and the request it belonged to. */
  const pendingKey = useRef<{ key: string; request: string } | null>(null);

  const atLimit = projectsToday.used >= projectsToday.limit;

  function showTextError(message: string) {
    setTextError(message);
    textRef.current?.focus();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setFormError(null);
    const idea = cleanIdeaText(text);
    const problem = ideaProblem(idea);
    if (problem === "empty") return showTextError(MESSAGES.EMPTY);
    if (problem === "too_short") return showTextError(MESSAGES.TOO_SHORT);
    if (problem === "too_long") return showTextError(MESSAGES.TOO_LONG);

    const body = JSON.stringify({ inputType: ideaInputType(idea), text: idea, language, voiceGender });
    const key = pendingKey.current?.request === body ? pendingKey.current.key : newIdempotencyKey();
    pendingKey.current = { key, request: body };

    setBusy(true);
    let response: Response;
    try {
      response = await fetch("/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        credentials: "same-origin",
        body,
      });
    } catch {
      // No answer: the project may or may not be saved. Keep the key, so pressing the button
      // again with the same idea gets the saved project instead of a second one.
      setBusy(false);
      setFormError(MESSAGES.OFFLINE);
      return;
    }

    const json = (await response.json().catch(() => ({}))) as ApiErrorBody & { project?: { id?: string } };
    if (response.ok && typeof json.project?.id === "string") {
      window.location.assign(`/projects/${json.project.id}`);
      return;
    }

    setBusy(false);
    const code = json.error?.code ?? "";
    const message = json.error?.message ?? MESSAGES.INTERNAL;
    // A clear answer: the next click is a new request (5xx and "still working" keep the key).
    if (response.status < 500 && code !== "IDEMPOTENCY_IN_PROGRESS") pendingKey.current = null;

    switch (code) {
      case "UNAUTHENTICATED":
        window.location.assign("/login");
        return;
      case "INVALID_INPUT": {
        const textIssue = json.error?.details?.issues?.find((i) => i.path === "text");
        if (textIssue) return showTextError(idea.length > IDEA_TOPIC_MAX_CHARS ? `Your notes ${textIssue.message}.` : `Your topic ${textIssue.message}.`);
        return setFormError(message);
      }
      case "QUOTA_EXCEEDED":
        return setFormError(message + resetTimeText(json.error?.details?.resetsAt, timezone));
      default:
        return setFormError(response.status >= 500 ? MESSAGES.INTERNAL : message);
    }
  }

  const count = cleanIdeaText(text).length;
  const over = count > MAX_CHARS;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col">
      <h1 className="mb-6 font-display text-2xl font-bold tracking-tight text-text sm:text-[28px]">
        <label htmlFor="idea-text">What do you want to explain?</label>
      </h1>

      <div
        className={cn(
          "relative rounded-2xl border bg-surface-2 p-4 pb-9 transition-colors focus-within:border-gold-cream",
          textError ? "border-danger" : "border-line",
        )}
      >
        <textarea
          ref={textRef}
          id="idea-text"
          name="text"
          rows={6}
          maxLength={SAFETY_MAX_LENGTH}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (textError) setTextError(null);
          }}
          disabled={busy}
          aria-invalid={textError ? true : undefined}
          aria-describedby={textError ? "idea-text-help idea-text-error" : "idea-text-help"}
          placeholder="e.g. How UPI payments work"
          className="block w-full resize-y bg-transparent text-base leading-relaxed text-text placeholder:text-muted/60 focus:outline-none disabled:opacity-60"
        />
        <p aria-hidden="true" className={cn("absolute right-4 bottom-3 font-mono text-xs", over ? "text-danger" : count === MAX_CHARS ? "text-warning" : "text-muted")}>
          {count.toLocaleString("en-US")} / {MAX_CHARS.toLocaleString("en-US")}
        </p>
      </div>
      {textError && (
        <p id="idea-text-error" className="mt-2 text-[13px] text-danger">
          {textError}
        </p>
      )}
      <p id="idea-text-help" className="mt-2 mb-7 text-xs text-muted">
        Type a topic, or paste your notes (up to 5,000 characters).
        {count === MAX_CHARS && <span className="text-warning"> You&apos;ve reached the limit.</span>}
        {over && <span className="text-danger"> That&apos;s {(count - MAX_CHARS).toLocaleString("en-US")} too many. Please shorten it.</span>}
      </p>

      <ChoiceChips label="Language" options={LANGUAGE_OPTIONS} value={language} onChange={setLanguage} disabled={busy} className="mb-6" />
      <ChoiceChips label="Voice" options={VOICE_OPTIONS} value={voiceGender} onChange={setVoiceGender} disabled={busy} className="mb-10" />

      {formError && (
        <div role="alert" className="mb-5 rounded-2xl border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-text">
          {formError}
        </div>
      )}

      <Button type="submit" fullWidth disabled={busy} aria-busy={busy}>
        {busy ? "Saving your idea…" : "Create storyboard"}
      </Button>
      <p className={cn("mt-4 text-center font-mono text-[11px] uppercase tracking-wider", atLimit ? "text-warning" : "text-muted")}>
        Projects today: {projectsToday.used} of {projectsToday.limit}
      </p>
    </form>
  );
}
