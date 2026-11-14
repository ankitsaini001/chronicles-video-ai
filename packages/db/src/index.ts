// @bytereel/db: the one place that talks to MongoDB (docs/DATABASE.md, docs/ARCHITECTURE.md §8).
export { closeMongoClient, getDb, getMongoClient, CLIENT_OPTIONS } from "./client";
export { DEFAULT_DB_NAME, passwordsIn, readDbConfig, redactConnectionString, type DbConfig, type DbConfigResult } from "./config";
export { explainDbError, IndexConflictError, type ExplainedDbError } from "./errors";
export { ping } from "./health";
export {
  API_RATE_LIMITS,
  AUTH_RATE_LIMITS,
  hashRateLimitSubject,
  hitRateLimit,
  RATE_LIMITS_COLLECTION,
  rateLimitId,
  rateLimitWindow,
  type RateLimitDocument,
  type RateLimitResult,
  type RateLimitRule,
} from "./rate-limit";
export {
  getLoginLock,
  LOGIN_LOCKOUT,
  recordFailedLogin,
  recordSuccessfulLogin,
  USER_COLLECTION,
  type LoginGuardUser,
  type LoginLock,
} from "./login-guard";
export { DEFAULT_TIMEZONE, isValidTimezone, USAGE_LIMITS, usagePeriods, type UsagePeriods } from "./usage";
export { ensureIndexes, INDEX_FEATURES, INDEXES, indexesForFeatures, type IndexDefinition } from "./indexes";
export {
  addInvite,
  ALLOWLIST_COLLECTION,
  InviteInputError,
  isInvited,
  listInvites,
  markInviteSignedUp,
  normalizeEmail,
  removeInvite,
  type AddInviteResult,
  type AllowlistEntry,
} from "./allowlist";
export {
  beginIdempotency,
  finishIdempotency,
  finishIdempotencyInTransaction,
  IDEMPOTENCY_COLLECTION,
  IDEMPOTENCY_LOCK_MS,
  IdempotencyLockLostError,
  releaseIdempotency,
  type IdempotencyBeginResult,
  type IdempotencyDocument,
  type IdempotencyLock,
} from "./idempotency";
export {
  addUsageWithinLimit,
  readUsageCount,
  USAGE_COUNTERS_COLLECTION,
  usageCounterPeriod,
  type UsageAddResult,
  type UsageCounterDocument,
  type UsageKind,
} from "./usage-counters";
export {
  CREATE_PROJECT_STATUS,
  createProject,
  CreateProjectBodySchema,
  currentStepOf,
  getOwnedProject,
  IDEA_LIMITS,
  INPUT_TYPES,
  LANGUAGES,
  PROJECT_SCHEMA_VERSION,
  ProjectQuotaExceededError,
  PROJECTS_COLLECTION,
  TITLE_MAX,
  titleFromIdea,
  toProjectResource,
  VOICE_GENDERS,
  type CreateProjectBody,
  type CreateProjectResponse,
  type InputType,
  type Language,
  type ProjectDocument,
  type ProjectResource,
  type ProjectState,
  type ProjectStep,
  type VoiceGender,
} from "./projects";
export {
  BRAINSTORM_LIMITS,
  BRAINSTORM_TEXT_MAX_CHARS,
  brainstormIdeaText,
  cleanIdeaText,
  fitsBrainstormText,
  IDEA_MAX_CHARS,
  IDEA_MIN_CHARS,
  IDEA_TOPIC_MAX_CHARS,
  ideaInputType,
  ideaProblem,
} from "./idea-text";
export {
  VOICE_PRESET_LIST,
  VOICE_TEXT_LANG,
  voicePresetFor,
  type VoiceLanguage,
  type VoicePresetGender,
  type VoicePresetId,
  type VoicePresetInfo,
} from "./voices";
export {
  finishProviderUsage,
  PROVIDER_USAGE_COLLECTION,
  PROVIDER_USAGE_SCHEMA_VERSION,
  reserveProviderUsage,
  type ProviderUsageDocument,
  type ProviderUsageUnits,
  type UsageProvider,
} from "./provider-usage";
export {
  BRAINSTORM_SUBJECT_LIMITS,
  BrainstormBodySchema,
  countBrainstormWithinLimit,
  type BrainstormBody,
  type BrainstormCountResult,
} from "./brainstorm";
