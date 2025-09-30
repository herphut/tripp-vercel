// @/app/api/_lib/rateLimits.ts
import "server-only";
// ------- Types -------
type Bucket = { count: number; resetAt: number };
type Store = Map<string, Bucket>;

export type RateLimitOptions = {
  /** max requests in the window (default 30) */
  limit?: number;
  /** window length in seconds (default 60) */
  window?: number;
};

// ------- Global store (persists across hot reloads) -------
declare global { var __rl_store: Store | undefined }
const g = globalThis as any;
const store: Store = g.__rl_store ?? (g.__rl_store = new Map());


// ------- Core limiter: fixed window counter -------
/**
 * Rate limit by arbitrary key. Fixed window (simple & fast).
 * @param key A unique identifier, e.g. `rl:{clientId}:{ip}:{path}`
 * @param opts Optional { limit, window } override
 * @returns { allowed, remaining, reset, limit, window }
 */
export async function rateLimit(
  key: string,
  opts: RateLimitOptions = {}
): Promise<{
  allowed: boolean;
  remaining: number;
  reset: number;    // epoch seconds when window resets
  limit: number;
  window: number;   // seconds
}> {
  const LIMIT = opts.limit ?? 30;   // default 30 req
  const WINDOW = opts.window ?? 60; // default 60 s

  const now = Math.floor(Date.now() / 1000);

  let b = store.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + WINDOW };
    store.set(key, b);
  }

  b.count += 1;

  const allowed = b.count <= LIMIT;
  const remaining = Math.max(0, LIMIT - b.count);

  return { allowed, remaining, reset: b.resetAt, limit: LIMIT, window: WINDOW };
}

// Back-compat alias used in your middleware
export { rateLimit as burstLimit };

/**
 * Helper to build a consistent key from request parts.
 * Use this in middleware so all routes key the same way.
 */
export function buildRateKey(params: {
  clientId: string;
  ip: string;
  path: string;
  // Optional: add userId/sessionId if you want tighter scoping
  userId?: string | null;
  sessionId?: string | null;
}) {
  const { clientId, ip, path, userId, sessionId } = params;
  const uid = userId ?? "-";
  const sid = sessionId ?? "-";
  return `rl:${clientId}:${ip}:${uid}:${sid}:${path}`;
}
