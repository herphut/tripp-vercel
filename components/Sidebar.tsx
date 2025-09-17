// components/Sidebar.tsx
"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import MemoryToggle from "@/components/settings/MemoryToggle";

type Session = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string | null;
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

  // Ensure cookie mirrors local session id and return it
  function ensureSessionCookie(): string {
    let sid = localStorage.getItem("tripp:sessionId");
    if (!sid) {
      sid = (crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));
      localStorage.setItem("tripp:sessionId", sid);
    }
    // 1-year cookie; SameSite=Lax
    document.cookie = `session_id=${sid}; Path=/; Max-Age=31536000; SameSite=Lax`;
    return sid;
  }

  // On mount: ensure cookie + fetch server truth once (source of truth)
  useEffect(() => {
    (async () => {
      try {
        const sid = ensureSessionCookie();
        const res = await fetch("/api/preferences/memory", {
          headers: { "X-Session-Id": sid },
          cache: "no-store",
        });
        const data = await res.json();
        const val = !!data?.memoryOptIn;
        setOptedIn(val);
        localStorage.setItem("tripp:memoryOptIn", String(val));
      } catch {
        // ignore network hiccups
      }
    })();
  }, []);

  // React immediately when the toggle changes (via custom event) and cross-tab LS updates
  useEffect(() => {
    function onChanged(ev: Event) {
      const next = (ev as CustomEvent<boolean>).detail;
      setOptedIn(!!next);
    }
    function onStorage(ev: StorageEvent) {
      if (ev.key === "tripp:memoryOptIn") setOptedIn(ev.newValue === "true");
    }
    window.addEventListener("tripp:memoryChanged", onChanged as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("tripp:memoryChanged", onChanged as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Load recent sessions only when opted-in
  useEffect(() => {
    if (!optedIn) {
      setSessions([]);
      return;
    }
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/session?list=1", { cache: "no-store" });
        const json = await res.json();
        const arr: unknown = Array.isArray(json) ? json : json?.sessions;
        setSessions(Array.isArray(arr) ? (arr as Session[]) : []);
      } catch {
        setSessions([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [optedIn]);

  function select(id: string) {
    // Fire DOM event; page can listen and react (no function props)
    window.dispatchEvent(new CustomEvent("tripp:selectSession", { detail: id }));
  }

  async function clearSessionHistory() {
    if (!confirm("Clear this session's chat history?")) return;
    await fetch("/api/preferences/clear", { method: "POST" }).catch(() => {});
    window.dispatchEvent(new CustomEvent("tripp:clearedSession"));
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
            {/* Open Settings button (only shows when not opted-in) */}
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
                        {s.updated_at ?? s.created_at}
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
          onClick={() => setShowSettings(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[420px] max-w-[90vw] bg-[#111317] text-white border border-zinc-800 rounded-xl p-4"
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold m-0">Settings</h3>
              <button onClick={() => setShowSettings(false)} className="opacity-70 hover:opacity-100">✖</button>
            </div>

            <div className="space-y-4">
              <div className="p-3 rounded-md border border-zinc-800 bg-[#14161a]">
                <div className="font-semibold mb-1">Memory</div>
                <div className="text-xs opacity-80 mb-2">
                  Turn on to let Tripp remember your conversations. You can turn this off anytime.
                </div>
                <MemoryToggle />
              </div>

              <div className="flex justify-end">
                <button
                  onClick={clearSessionHistory}
                  className="text-sm px-3 py-2 rounded border border-zinc-700 hover:bg-zinc-800"
                >
                  Clear this session’s history
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
