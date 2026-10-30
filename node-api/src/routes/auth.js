import { hashPassword, verifyPassword } from "../lib/crypto.js";

const credentialsSchema = {
  type: "object",
  required: ["email", "password"],
  additionalProperties: false,
  properties: {
    email: { type: "string", format: "email", maxLength: 320 },
    password: { type: "string", minLength: 8, maxLength: 200 },
  },
};

export async function authRoutes(app, { users }) {
  app.post(
    "/auth/register",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { body: credentialsSchema },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const user = await users.create({
        email,
        passwordHash: await hashPassword(password),
      });
      if (!user) {
        return reply.code(409).send({ error: "email_taken" });
      }
      const token = app.jwt.sign({ sub: user.id, email: user.email });
      return reply.code(201).send({ user, token });
    },
  );

  app.post(
    "/auth/login",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: { body: credentialsSchema },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const user = await users.findByEmail(email);
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      const token = app.jwt.sign({ sub: user.id, email: user.email });
      return reply.send({
        user: { id: user.id, email: user.email, createdAt: user.createdAt },
        token,
      });
    },
  );

  app.get("/auth/me", { preHandler: app.authenticate }, async (request, reply) => {
    const user = await users.findById(request.user.sub);
    if (!user) {
      return reply.code(404).send({ error: "user_not_found" });
    }
    return reply.send({ user: { id: user.id, email: user.email, createdAt: user.createdAt } });
  });
}
