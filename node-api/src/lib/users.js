import { randomUUID } from "node:crypto";

function publicUser(user) {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

export class UserRepository {
  constructor(redis) {
    this.redis = redis;
  }

  async create({ email, passwordHash }) {
    const normalized = email.trim().toLowerCase();
    const user = {
      id: randomUUID(),
      email: normalized,
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    const inserted = await this.redis.set(
      `amp:user:${normalized}`,
      JSON.stringify(user),
      "NX",
    );
    if (inserted !== "OK") {
      return null;
    }
    await this.redis.set(`amp:userid:${user.id}`, normalized);
    return publicUser(user);
  }

  async findByEmail(email) {
    const raw = await this.redis.get(`amp:user:${email.trim().toLowerCase()}`);
    return raw ? JSON.parse(raw) : null;
  }

  async findById(id) {
    const email = await this.redis.get(`amp:userid:${id}`);
    return email ? this.findByEmail(email) : null;
  }
}
