/** Fixed-window limiter in-memory (single process). Tahap scale-out: pindah ke store bersama. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private now: () => number = Date.now) {}

  check(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSec: number } {
    const t = this.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    const rec = this.hits.get(key);
    if (!rec || rec.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + windowMs });
      return { allowed: true, retryAfterSec: 0 };
    }
    rec.count++;
    return rec.count > limit
      ? { allowed: false, retryAfterSec: Math.max(1, Math.ceil((rec.resetAt - t) / 1000)) }
      : { allowed: true, retryAfterSec: 0 };
  }

  reset(key: string) {
    this.hits.delete(key);
  }
}
