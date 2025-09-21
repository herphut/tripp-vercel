"use client";

import { useEffect, useState } from "react";

type PrefsResp =
  | { memory_opt_in: boolean }              // success
  | { error: string; reason?: string };     // error shape

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
          headers: { "Accept": "application/json" },
        });
        const j = (await r.json()) as PrefsResp;
        if (!cancelled) {
          if ("memory_opt_in" in j) setOn(!!j.memory_opt_in);
          else {
            setOn(false);
            setErr(j.error || "prefs_error");
          }
        }
      } catch (e: any) {
        if (!cancelled) {
          setOn(false);
          setErr("prefs_fetch_failed");
        }
      }
    })();
    return () => { cancelled = true; };
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
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({ memory_opt_in: next }),
      });

      const j = (await r.json()) as PrefsResp;
      if ("memory_opt_in" in j) {
        setOn(!!j.memory_opt_in); // confirm server truth
      } else {
        // rollback on server error
        setOn(!next);
        setErr(j.error || "prefs_set_error");
      }
    } catch {
      setOn(!next); // rollback on network error
      setErr("prefs_network_error");
    } finally {
      setSaving(false);
    }
  }

  const label =
    on === null ? "…" : on ? "Memory: On" : "Memory: Off";

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
      {err && (
        <span className="text-xs text-white/60" title={err}>
          (sync issue)
        </span>
      )}
    </div>
  );
}
