// src/lib/session.ts
export type ExchangeOK = { session_id: string; user_id: string; expires_at: string };

export async function exchange(): Promise<ExchangeOK> {
  const r = await fetch("/api/auth/exchange", {
    method: "POST",
    credentials: "include", // <-- critical for cookies
    headers: { "content-type": "application/json" },
  });

  if (r.status === 401) {
    // Server should return { refresh: "https://herphut.com/?hh_sso_refresh=1&return=..." }
    const { refresh } = await r.json().catch(() => ({}));
    if (refresh) window.location.href = refresh;
    throw new Error("401: needs refresh");
  }
  if (!r.ok) throw new Error(`exchange failed: ${r.status}`);
  return r.json();
}

export async function getMemoryPref(): Promise<{ memoryOptIn: boolean }> {
  const r = await fetch("/api/preferences/memory", {
    method: "GET",
    credentials: "include",
  });
  if (!r.ok) throw new Error(`pref fetch failed: ${r.status}`);
  return r.json();
}
