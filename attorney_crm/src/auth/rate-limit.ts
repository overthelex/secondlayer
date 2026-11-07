// In-memory per-e-mail login throttle: after `limit` failures inside `windowMs`
// the next attempt is refused. One process serves the CRM, so memory is enough.
export class LoginRateLimit {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  private key(email: string): string {
    return email.trim().toLowerCase();
  }

  private recent(email: string, now: number): number[] {
    const list = (this.failures.get(this.key(email)) ?? []).filter((t) => now - t < this.windowMs);
    this.failures.set(this.key(email), list);
    return list;
  }

  isBlocked(email: string, now: number = Date.now()): boolean {
    return this.recent(email, now).length >= this.limit;
  }

  recordFailure(email: string, now: number = Date.now()): void {
    this.recent(email, now).push(now);
  }

  reset(email: string): void {
    this.failures.delete(this.key(email));
  }
}
