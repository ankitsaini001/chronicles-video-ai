import type { Metadata } from "next";
import Link from "next/link";
import { ProjectStepper } from "@/components/app/ProjectStepper";
import { IdeaForm } from "@/components/project/IdeaForm";
import { getUsage } from "@/lib/account/me";
import { requireUser } from "@/lib/auth/session";
import { availableSamples } from "@/lib/voices";

// ① Idea (Stitch "ByteReel — Step 1 Idea", ARCHITECTURE §11 `/projects/new`).
// F12: topic/notes, Language, Voice and "Create storyboard" (saves the project, C2).
// F13: ▶ voice samples (static MP3s, components/project/VoicePicker.tsx), only for presets whose
// MP3 is recorded (checked here on the server; Hindi/Hinglish wait until before F23).
// Not yet: ✨ Brainstorm with AI (F14), the AI storyboard (F15).
// Language and voice start at the user's defaults (English + Female for new accounts).

export const metadata: Metadata = { title: "New video" };

export default async function NewProjectPage() {
  // The layout checks too, but layouts don't re-run on every navigation (see app/(app)/layout.tsx).
  const user = await requireUser();
  const usage = await getUsage(user);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col">
      <div className="relative mb-6 flex flex-col items-center gap-4 sm:mb-8 sm:flex-row sm:justify-center">
        <Link href="/dashboard" className="self-start text-xs font-medium text-muted transition-colors hover:text-text sm:absolute sm:left-0 sm:self-center">
          ← My videos
        </Link>
        <ProjectStepper current="idea" />
      </div>
      <div className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-10">
        <IdeaForm
          defaultLanguage={user.defaultLanguage}
          defaultVoiceGender={user.defaultVoiceGender}
          projectsToday={usage.projectsToday}
          timezone={user.timezone}
          samplePresets={[...availableSamples()]}
        />
      </div>
    </div>
  );
}
