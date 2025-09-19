// src/hooks/useTrippSession.ts
"use client";

import { useEffect, useState } from "react";
import { exchange, getMemoryPref } from "@/lib/session";

export function useTrippSession() {
  const [ready, setReady] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const x = await exchange();                 // sets HH_SESSION_ID cookie
        if (cancelled) return;
        setSessionId(x.session_id);
        setUserId(x.user_id);

        const pref = await getMemoryPref();         // read user_prefs
        if (cancelled) return;
        setMemoryEnabled(!!pref.memoryOptIn);
      } catch (e: any) {
        setError(e?.message || "boot failed");
      } finally {
        setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { ready, sessionId, userId, memoryEnabled, error };
}
