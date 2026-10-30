export async function jobRoutes(app, { jobs }) {
  app.get("/jobs", { preHandler: app.authenticate }, async (request, reply) => {
    const limit = Math.min(Number.parseInt(request.query.limit ?? "25", 10) || 25, 100);
    const items = await jobs.listForUser(request.user.sub, limit);
    return reply.send({ items });
  });

  app.get("/jobs/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const job = await jobs.get(request.params.id);
    if (!job || job.userId !== request.user.sub) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send({ job });
  });
}
