"use client";
import { useEffect, useState } from "react";

const LS_KEY = "tripp:memoryOptIn";
const LS_SID = "tripp:sessionId";

function ensureSessionCookie(): string {
  let sid = localStorage.getItem(LS_SID);
  if (!sid) {
    sid = (crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));
    localStorage.setItem(LS_SID, sid);
  }
  // 1 year cookie, lax
  document.cookie = `session_id=${sid}; Path=/; Max-Age=31536000; SameSite=Lax`;
  return sid;
}

export default function MemoryToggle() {
  const [loading, setLoading] = useState(true);
  const [optIn, setOptIn] = useState(false);

  useEffect(() => {
    const sid = ensureSessionCookie();
    (async () => {
      try {
        const res = await fetch("/api/preferences/memory", { headers: { "X-Session-Id": sid } });
        const data = await res.json();
        if (typeof data?.memoryOptIn === "boolean") {
          setOptIn(data.memoryOptIn);
          localStorage.setItem(LS_KEY, String(data.memoryOptIn));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.checked;
    setOptIn(next);
    localStorage.setItem(LS_KEY, String(next));
    window.dispatchEvent(new CustomEvent("tripp:memoryChanged", { detail: next }));

    const sid = ensureSessionCookie();
    fetch("/api/preferences/memory", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Session-Id": sid },
      body: JSON.stringify({ memoryOptIn: next }),
    }).catch(() => {});
  }

  return (
    <label className="flex items-center gap-3">
      <input
        type="checkbox"
        className="h-5 w-5"
        aria-label="Opt in to memory"
        checked={optIn}
        onChange={onChange}
        disabled={loading}
      />
      <span className="text-sm">Remember my chats (stores conversation history).</span>
    </label>
  );
}

