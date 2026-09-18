/**
 * Einfache Nutzungsbegrenzung (Briefing 17.4): Fenster je Schlüssel im Prozessspeicher.
 * Für einen einzelnen Anwendungsprozess (Pilot) ausreichend; bei mehreren Instanzen ist ein
 * gemeinsamer Speicher (z. B. PostgreSQL-Tabelle oder Redis) nötig – siehe docs/betrieb.md.
 */
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

export function checkRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  if (b.count >= limit) return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  b.count++;
  // Speicher begrenzen
  if (buckets.size > 10000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  return { allowed: true, remaining: limit - b.count, retryAfterSeconds: 0 };
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
}

/** Grenzen (Standardwerte; über Umgebungsvariablen anpassbar) */
export const LIMITS = {
  login: { limit: Number(process.env.RATE_LIMIT_LOGIN_PER_15MIN ?? 20), windowMs: 15 * 60 * 1000 },
  write: { limit: Number(process.env.RATE_LIMIT_WRITES_PER_MIN ?? 120), windowMs: 60 * 1000 },
};
