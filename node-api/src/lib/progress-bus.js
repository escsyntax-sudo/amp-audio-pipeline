import { EventEmitter } from "node:events";

export class ProgressBus extends EventEmitter {
  constructor(redis, channel) {
    super();
    this.channel = channel;
    this.subscriber = redis.duplicate();
    this.started = false;
  }

  async start() {
    if (this.started) {
      return;
    }
    this.subscriber.on("message", (channel, payload) => {
      if (channel !== this.channel) {
        return;
      }
      try {
        this.emit("event", JSON.parse(payload));
      } catch {
        this.emit("error", new Error("received malformed progress event"));
      }
    });
    await this.subscriber.subscribe(this.channel);
    this.started = true;
  }

  subscribe(userId, listener) {
    const handler = (event) => {
      if (event.userId === userId) {
        listener(event);
      }
    };
    this.on("event", handler);
    return () => this.off("event", handler);
  }

  async close() {
    if (this.started) {
      await this.subscriber.quit();
      this.started = false;
    }
    this.removeAllListeners();
  }
}
