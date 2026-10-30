export class FakeRedis {
  constructor() {
    this.strings = new Map();
    this.hashes = new Map();
    this.sorted = new Map();
    this.published = [];
  }

  async get(key) {
    return this.strings.get(key) ?? null;
  }

  async set(key, value, ...flags) {
    if (flags.includes("NX") && this.strings.has(key)) {
      return null;
    }
    this.strings.set(key, value);
    return "OK";
  }

  async del(key) {
    return this.strings.delete(key) || this.hashes.delete(key) || this.sorted.delete(key) ? 1 : 0;
  }

  async hset(key, values) {
    const hash = this.hashes.get(key) ?? new Map();
    for (const [field, value] of Object.entries(values)) {
      hash.set(field, String(value));
    }
    this.hashes.set(key, hash);
    return Object.keys(values).length;
  }

  async hgetall(key) {
    const hash = this.hashes.get(key);
    return hash ? Object.fromEntries(hash) : {};
  }

  async expire() {
    return 1;
  }

  async zadd(key, score, member) {
    const set = this.sorted.get(key) ?? new Map();
    set.set(member, Number(score));
    this.sorted.set(key, set);
    return 1;
  }

  async zrevrange(key, start, stop) {
    const set = this.sorted.get(key);
    if (!set) {
      return [];
    }
    const ordered = [...set.entries()].sort((a, b) => b[1] - a[1]).map(([member]) => member);
    const end = stop < 0 ? ordered.length + stop + 1 : stop + 1;
    return ordered.slice(start, end);
  }

  async publish(channel, payload) {
    this.published.push({ channel, payload: JSON.parse(payload) });
    return 0;
  }

  async ping() {
    return "PONG";
  }
}

export class FakeQueue {
  constructor() {
    this.jobs = [];
    this.counts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  }

  async add(name, data, options) {
    const job = { name, data, options };
    this.jobs.push(job);
    this.counts.waiting += 1;
    return job;
  }

  async getJobCounts() {
    return this.counts;
  }
}

export class FakeBus {
  constructor() {
    this.listeners = new Map();
  }

  subscribe(userId, listener) {
    const list = this.listeners.get(userId) ?? new Set();
    list.add(listener);
    this.listeners.set(userId, list);
    return () => list.delete(listener);
  }

  emitFor(userId, event) {
    for (const listener of this.listeners.get(userId) ?? []) {
      listener(event);
    }
  }
}
