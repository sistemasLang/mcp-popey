/** Per-user request quota. Throws RateLimitExceededError when exhausted. */
export interface RateLimiterPort {
  consume(userId: string): void;
}
