// components/Sidebar.tsx
"use client";

import * as React from "react";
import { useEffect, useState, useCallback } from "react";
import MemoryToggle from "@/components/settings/MemoryToggle";
import { getMemoryPref } from "@/src/lib/session"; // returns boolean

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}


type Session = {
  id: string;                 // sessionId
  title: string | null;       // session title (nullable)
  created_at: string;         // ISO
  first_user_at?: string | null; // ISO, nullable
  updated_at: string | null;  // ISO
  last_seen?: string | null;  // ISO, optional
};

type SidebarProps = {
  /** Optional element on the right of the header (e.g., "+ New chat") */
  headerExtra?: React.ReactNode;
};

export default function Sidebar({ headerExtra }: SidebarProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [optedIn, setOptedIn] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const fetchSessions = useCallback(async () => {
    if (!optedIn) {
      setSessions([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/session?list=1", {
        cache: "no-store",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const json = await res.json();
      const arr: unknown = Array.isArray(json) ? json : (json?.sessions as unknown);
      setSessions(Array.isArray(arr) ? (arr as Session[]) : []);
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [optedIn]);

  // Fetch server-truth for memory on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const on = await getMemoryPref();
      if (!cancelled) {
        setOptedIn(on);
        localStorage.setItem("tripp:memoryOptIn", String(on));
        if (on) void fetchSessions();
      }
    })();
    return () => { cancelled = true; };
  }, [fetchSessions]);

  // React when the toggle changes (custom event) and cross-tab LS updates
  useEffect(() => {
    function onChanged(ev: Event) {
      const next = (ev as CustomEvent<boolean>).detail;
      setOptedIn(!!next);
      localStorage.setItem("tripp:memoryOptIn", String(!!next));
      if (next) void fetchSessions(); else setSessions([]);
    }
    function onStorage(ev: StorageEvent) {
      if (ev.key === "tripp:memoryOptIn") {
        const next = ev.newValue === "true";
        setOptedIn(next);
        if (next) void fetchSessions(); else setSessions([]);
      }
    }
    window.addEventListener("tripp:memoryChanged", onChanged as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("tripp:memoryChanged", onChanged as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, [fetchSessions]);

  // Load sessions whenever optedIn flips true
  useEffect(() => { if (optedIn) void fetchSessions(); }, [optedIn, fetchSessions]);

  // Also refresh after closing settings (handy right after saving)
  function closeSettings() {
    setShowSettings(false);
    if (optedIn) void fetchSessions();
  }

  function select(id: string) {
    window.dispatchEvent(new CustomEvent("tripp:selectSession", { detail: id }));
  }

  // small util: prefer first_user_at > created_at for the subtitle
  function subtitleFor(s: Session) {
  const when = s.first_user_at ?? s.created_at ?? s.updated_at;
  return formatDate(when);
}

  return (
    <aside className="w-72 shrink-0 border-r border-zinc-800 h-screen overflow-y-auto text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <h3 className="text-sm font-semibold">Chats</h3>
        <div className="flex items-center gap-2">
          {headerExtra /* e.g., "+ New chat" */}
          <button
            onClick={() => setShowSettings(true)}
            aria-label="Settings"
            className="text-sm px-2 py-1 rounded border border-zinc-700 hover:bg-zinc-800"
          >
            ⚙️
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="p-3">
        {!optedIn ? (
          <div className="space-y-2">
            <div className="text-sm opacity-80">
              Turn on memory to see recent chats here.
            </div>
            <button
              onClick={() => setShowSettings(true)}
              className="text-sm px-3 py-2 rounded border border-zinc-700 hover:bg-zinc-800"
            >
              Open Settings
            </button>
          </div>
        ) : (
          <>
            {loading && <div className="opacity-70">Loading…</div>}
            {!loading && sessions.length === 0 ? (
              <div className="opacity-70">No chats yet.</div>
            ) : (
              <ul className="list-none p-0 m-0 space-y-2">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <button
                      onClick={() => select(s.id)}
                      className="w-full text-left px-3 py-2 rounded-md bg-[#1f2328] border border-[#30363d] hover:bg-[#242a31] transition"
                    >
                      <div className="text-sm">
                        {s.title ?? `Chat ${s.id.slice(0, 8)}`}
                      </div>
                      <div className="text-xs opacity-70">
                        {subtitleFor(s)}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {/* Settings Modal (ONLY place with MemoryToggle) */}
      {showSettings && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 bg-black/50 grid place-items-center z-50"
          onClick={closeSettings}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[420px] max-w-[90vw] bg-[#111317] text-white border border-zinc-800 rounded-xl p-4"
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold m-0">Settings</h3>
              <button onClick={closeSettings} className="opacity-70 hover:opacity-100">✖</button>
            </div>

            <div className="space-y-4">
              <div className="p-3 rounded-md border border-zinc-800 bg-[#14161a]">
                <div className="font-semibold mb-1">Memory</div>
                <div className="text-xs opacity-80 mb-2">
                  Turn on to let Tripp remember your conversations. You can turn this off anytime.
                </div>
                <MemoryToggle />
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
