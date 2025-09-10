// Simple fixed-window limiter: 30 req / 60s per key
type Result = { allowed: boolean; remaining: number; reset: number };

const WINDOW_MS = 60_000;
const LIMIT = 30;

const store = new Map<string, { count: number; windowStart: number }>();

export async function rateLimit(key: string): Promise<Result> {
  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;

  const entry = store.get(key);
  if (!entry || entry.windowStart !== windowStart) {
    store.set(key, { count: 1, windowStart });
    return {
      allowed: true,
      remaining: LIMIT - 1,
      reset: Math.floor((windowStart + WINDOW_MS) / 1000),
    };
  }

  entry.count += 1;
  return {
    allowed: entry.count <= LIMIT,
    remaining: Math.max(LIMIT - entry.count, 0),
    reset: Math.floor((entry.windowStart + WINDOW_MS) / 1000),
  };
}
