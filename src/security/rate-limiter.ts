import { RateLimitExceededError } from '../errors/app-errors.js';

export interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
}

/** Sliding-window limiter keyed by userId (not by IP). In-memory, per process. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(private readonly options: RateLimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  consume(userId: string): void {
    const now = this.now();
    const windowStart = now - this.options.windowMs;
    const recent = (this.hits.get(userId) ?? []).filter((timestamp) => timestamp > windowStart);

    if (recent.length >= this.options.maxRequests) {
      this.hits.set(userId, recent);
      const retryAfterSeconds = Math.ceil(((recent[0] ?? now) + this.options.windowMs - now) / 1000);
      throw new RateLimitExceededError(`Rate limit exceeded; retry in ${retryAfterSeconds}s`);
    }

    recent.push(now);
    this.hits.set(userId, recent);
    this.sweep(now, windowStart);
  }

  /** Drops users with no activity in the window so the map does not grow forever. */
  private sweep(now: number, windowStart: number): void {
    if (now - this.lastSweep < this.options.windowMs) return;
    this.lastSweep = now;
    for (const [userId, timestamps] of this.hits) {
      if ((timestamps.at(-1) ?? 0) <= windowStart) this.hits.delete(userId);
    }
  }
}
