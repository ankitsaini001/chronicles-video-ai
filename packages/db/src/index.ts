// @bytereel/db: the one place that talks to MongoDB (docs/DATABASE.md, docs/ARCHITECTURE.md §8).
export { closeMongoClient, getDb, getMongoClient, CLIENT_OPTIONS } from "./client";
export { DEFAULT_DB_NAME, passwordsIn, readDbConfig, redactConnectionString, type DbConfig, type DbConfigResult } from "./config";
export { explainDbError, IndexConflictError, type ExplainedDbError } from "./errors";
export { ping } from "./health";
export {
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
