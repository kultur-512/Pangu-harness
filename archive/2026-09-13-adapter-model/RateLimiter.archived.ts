// src/utils/RateLimiter.ts
// Simple rate limiter to respect ~1 request per second (or configurable) on relays like Maoyulin.

export interface RateLimiterOptions {
  minIntervalMs?: number; // minimum time between calls, default 1000ms (1 req/s)
}

export class SimpleRateLimiter {
  private lastCallTime = 0;
  private minInterval: number;

  constructor(options: RateLimiterOptions = {}) {
    this.minInterval = options.minIntervalMs ?? 1000;
  }

  /**
   * Wait until it's safe to make the next call according to the rate limit.
   * Returns the actual wait time in ms (0 if no wait needed).
   */
  async wait(): Promise<number> {
    const now = Date.now();
    const elapsed = now - this.lastCallTime;
    const waitTime = Math.max(0, this.minInterval - elapsed);

    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastCallTime = Date.now();
    return waitTime;
  }

  /**
   * Record that a call was made right now (useful after external calls).
   */
  markCall() {
    this.lastCallTime = Date.now();
  }

  getMinInterval() {
    return this.minInterval;
  }
}
