import path from "node:path";

const DEFAULT_SECRET = "dev-insecure-secret";

function readInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const jwtSecret = process.env.JWT_SECRET ?? DEFAULT_SECRET;

if (nodeEnv === "production" && jwtSecret === DEFAULT_SECRET) {
  throw new Error("JWT_SECRET must be set when NODE_ENV=production");
}

export const config = {
  nodeEnv,
  port: readInt(process.env.PORT, 8080),
  host: process.env.HOST ?? "0.0.0.0",
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "12h",
  storageDir: path.resolve(process.env.STORAGE_DIR ?? "./data/uploads"),
  maxUploadBytes: readInt(process.env.MAX_UPLOAD_BYTES, 200 * 1024 * 1024),
  maxChunkBytes: readInt(process.env.MAX_CHUNK_BYTES, 8 * 1024 * 1024),
  maxChunks: readInt(process.env.MAX_CHUNKS, 5000),
  queueName: process.env.QUEUE_NAME ?? "amp-transcribe",
  eventsChannel: process.env.EVENTS_CHANNEL ?? "amp:events",
  maxJobAttempts: readInt(process.env.MAX_JOB_ATTEMPTS, 3),
  logLevel: process.env.LOG_LEVEL ?? "info",
  corsOrigin: process.env.CORS_ORIGIN?.trim() ? process.env.CORS_ORIGIN : false,
};
