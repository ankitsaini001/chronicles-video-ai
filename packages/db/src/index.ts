// @bytereel/db: the one place that talks to MongoDB (docs/DATABASE.md, docs/ARCHITECTURE.md §8).
export { closeMongoClient, getDb, getMongoClient, CLIENT_OPTIONS } from "./client";
export { DEFAULT_DB_NAME, passwordsIn, readDbConfig, redactConnectionString, type DbConfig, type DbConfigResult } from "./config";
export { explainDbError, IndexConflictError, type ExplainedDbError } from "./errors";
export {
  cleanupHealthCheck,
  HEALTHCHECK_COLLECTION,
  HEALTHCHECK_ID,
  ping,
  runHealthCheck,
  type HealthCheckResult,
  type HealthRecord,
} from "./health";
export { ensureIndexes, INDEX_FEATURES, INDEXES, indexesForFeatures, type IndexDefinition } from "./indexes";
