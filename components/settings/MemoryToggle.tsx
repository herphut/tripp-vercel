"use client";

import { useEffect, useState } from "react";

type PrefsResp =
  | { memory_opt_in: boolean }
  | { memoryOptIn: boolean }
  | { error: string; reason?: string }
  | Record<string, unknown>;

function readBoolShape(j: PrefsResp): boolean | null {
  if (j && typeof j === "object") {
    if ("memory_opt_in" in j) return !!(j as any).memory_opt_in;
    if ("memoryOptIn" in j) return !!(j as any).memoryOptIn;
    // tolerate { data: { memory_opt_in } } wrappers just in case
    const data = (j as any).data;
    if (data && typeof data === "object") {
      if ("memory_opt_in" in data) return !!data.memory_opt_in;
      if ("memoryOptIn" in data) return !!data.memoryOptIn;
    }
  }
  return null;
}

export default function MemoryToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Fetch current state on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setErr(null);
        const r = await fetch("/api/prefs", {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const j = (await r.json()) as PrefsResp;
        const v = readBoolShape(j);
        if (!cancelled) {
          if (v === null) {
            setOn(false);
            setErr((j as any)?.error || "bad_shape");
            console.debug("[MemoryToggle] GET /api/prefs unexpected payload:", j);
          } else {
            setOn(v);
            setErr(null);
          }
        }
      } catch (e) {
        if (!cancelled) {
          setOn(false);
          setErr("fetch_failed");
          console.debug("[MemoryToggle] GET /api/prefs failed:", e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle() {
    if (on === null || saving) return;
    const next = !on;

    setSaving(true);
    setErr(null);
    setOn(next); // optimistic UI

    try {
      const r = await fetch("/api/prefs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ memory_opt_in: next }),
      });
      const j = (await r.json()) as PrefsResp;
      const v = readBoolShape(j);
      if (v === null) {
        setOn(!next); // rollback
        setErr((j as any)?.error || "set_bad_shape");
        console.debug("[MemoryToggle] POST /api/prefs unexpected payload:", j);
      } else {
        setOn(v); // confirm truth from server
        setErr(null);
      }
    } catch (e) {
      setOn(!next); // rollback on network error
      setErr("set_failed");
      console.debug("[MemoryToggle] POST /api/prefs failed:", e);
    } finally {
      setSaving(false);
    }
  }

  const label = on === null ? "…" : on ? "Memory: On" : "Memory: Off";

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={toggle}
        disabled={on === null || saving}
        className="text-sm px-3 py-1 rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-50"
        aria-pressed={!!on}
        aria-busy={saving}
      >
        {label}
      </button>
      {err && <span className="text-xs text-white/60">(sync issue)</span>}
    </div>
  );
}
