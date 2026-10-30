import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";

import { authRoutes } from "./routes/auth.js";
import { uploadRoutes } from "./routes/uploads.js";
import { jobRoutes } from "./routes/jobs.js";
import { websocketRoutes } from "./routes/ws.js";
import { healthRoutes } from "./routes/health.js";

export async function buildApp({
  config,
  redis,
  queue,
  jobs,
  uploads,
  users,
  bus,
  enableRateLimit = true,
  logger = true,
}) {
  const app = Fastify({
    logger: logger ? { level: config.logLevel } : false,
    bodyLimit: config.maxChunkBytes + 1024,
    trustProxy: true,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.corsOrigin });
  if (enableRateLimit) {
    await app.register(rateLimit, {
      max: 120,
      timeWindow: "1 minute",
      redis,
    });
  }
  await app.register(jwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpiresIn },
  });
  await app.register(websocket);

  app.decorate("authenticate", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (request, body, done) => {
    done(null, body);
  });

  await app.register(authRoutes, { users });
  await app.register(uploadRoutes, { uploads, jobs, queue, config });
  await app.register(jobRoutes, { jobs });
  await app.register(websocketRoutes, { bus });
  await app.register(healthRoutes, { redis, queue });

  app.setErrorHandler((error, request, reply) => {
    if (error.validation) {
      return reply.code(400).send({
        error: "invalid_request",
        details: error.validation.map((item) => ({
          path: item.instancePath || item.params?.missingProperty || "",
          message: item.message,
        })),
      });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: error.code ?? "request_failed",
        message: error.message,
      });
    }
    request.log.error({ err: error }, "request failed");
    return reply.code(500).send({ error: "internal_error" });
  });

  return app;
}
