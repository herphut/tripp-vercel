// src/lib/rateLimits.ts
type Bucket = { count: number; resetAt: number };
type Store = Map<string, Bucket>;

declare global {
  // eslint-disable-next-line no-var
  var __rl_store: Store | undefined;
}

const store: Store = global.__rl_store ?? (global.__rl_store = new Map());

const LIMIT = 30;  // requests
const WINDOW = 60; // seconds

export async function rateLimit(key: string) {
  const now = Math.floor(Date.now() / 1000);
  let b = store.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + WINDOW };
    store.set(key, b);
  }
  b.count += 1;

  const allowed = b.count <= LIMIT;
  const remaining = Math.max(0, LIMIT - b.count);
  return { allowed, remaining, reset: b.resetAt };
}

export { rateLimit as burstLimit };