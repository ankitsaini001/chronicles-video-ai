import { USAGE_LIMITS, usagePeriods } from "@bytereel/db";
import type { SessionUser } from "../auth/session";

// The `Me` resource (docs/API.md B1, §11.3): what GET /api/v1/me answers and what the app shell
// shows. The route and the shell both call these functions directly (no HTTP call to ourselves),
// so the "Videos today" pill and the API always agree.
//
// What is real today and what arrives later:
// - usage: the limits and reset times are real; the counts are 0 until counting starts
//   (`usageCounters`: projects in F12, videos and voice characters with generation, F23/F27)
// - instagram: "not_connected" until F28 (Instagram connection)
// - unreadNotifications: 0 until F32 (notifications)
// - maintenance: off until the `settings` document exists (F27/F36)

export type Usage = { used: number; limit: number; resetsAt: string | null };

export type UsageSet = { videosToday: Usage; projectsToday: Usage; voiceCharactersThisMonth: Usage };

export type Me = {
  id: string;
  name: string;
  email: string;
  role: SessionUser["role"];
  timezone: string;
  defaultLanguage: SessionUser["defaultLanguage"];
  defaultVoiceGender: SessionUser["defaultVoiceGender"];
  createdAt: string;
  usage: UsageSet;
  instagram: { status: "not_connected" | "active" | "expired" | "revoked" | "error"; username: string | null };
  unreadNotifications: number;
  maintenance: { active: boolean; message: string | null };
};

/** This user's usage against the limits, with reset times in the user's timezone. */
export async function getUsage(user: Pick<SessionUser, "id" | "timezone">, now: Date = new Date()): Promise<UsageSet> {
  const periods = usagePeriods(user.timezone, now);
  return {
    videosToday: { used: 0, limit: USAGE_LIMITS.videosPerDay, resetsAt: periods.dayResetsAt.toISOString() },
    projectsToday: { used: 0, limit: USAGE_LIMITS.projectsPerDay, resetsAt: periods.dayResetsAt.toISOString() },
    voiceCharactersThisMonth: { used: 0, limit: USAGE_LIMITS.voiceCharactersPerMonth, resetsAt: periods.monthResetsAt.toISOString() },
  };
}

/**
 * B1 for the signed-in user. Built field by field from the safe session user, so the
 * login-protection fields (failedLoginCount, lockedUntil, lastLoginAt) can never appear.
 */
export async function getMe(user: SessionUser, now: Date = new Date()): Promise<Me> {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    timezone: user.timezone,
    defaultLanguage: user.defaultLanguage,
    defaultVoiceGender: user.defaultVoiceGender,
    createdAt: user.createdAt,
    usage: await getUsage(user, now),
    instagram: { status: "not_connected", username: null },
    unreadNotifications: 0,
    maintenance: { active: false, message: null },
  };
}
