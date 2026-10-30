export async function healthRoutes(app, { redis, queue }) {
  app.get("/healthz", async (request, reply) => {
    try {
      await redis.ping();
      const counts = await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
      return reply.send({ status: "ok", queue: counts });
    } catch (error) {
      request.log.error({ err: error }, "health check failed");
      return reply.code(503).send({ status: "degraded" });
    }
  });
}
