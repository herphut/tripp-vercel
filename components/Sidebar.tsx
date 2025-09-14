// components/Sidebar.tsx
"use client";

import { useEffect, useState } from "react";

type Session = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string | null;
};

export default function Sidebar(props: {
  onNewChat?: () => void;
  onSelectSession?: (id: string) => void;
  onClearMemory?: () => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/session?list=1");
        const json = await res.json();

        // Accept either `{sessions:[...]}` or `[...]` just in case
        const arr: unknown = Array.isArray(json) ? json : json?.sessions;
        setSessions(Array.isArray(arr) ? (arr as Session[]) : []);
      } catch {
        setSessions([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <aside style={{ width: 280, padding: 12, color: "#fff" }}>
      <h3 style={{ marginBottom: 8 }}>Recent Chats</h3>
      {loading && <div style={{ opacity: 0.7 }}>Loading…</div>}

      {sessions.length === 0 && !loading ? (
        <div style={{ opacity: 0.7 }}>No chats yet.</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {sessions.map((s) => (
            <li key={s.id} style={{ marginBottom: 8 }}>
              <button
                onClick={() => props.onSelectSession?.(s.id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: "#1f2328",
                  border: "1px solid #30363d",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                {s.title ?? `Chat ${s.id.slice(0, 8)}`}
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  {s.updated_at ?? s.created_at}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
        <button onClick={props.onNewChat} style={btnStyle}>New Chat</button>
        <button onClick={props.onClearMemory} style={{ ...btnStyle, background: "#b91c1c" }}>
          Clear Memory
        </button>
      </div>
    </aside>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  background: "#2563eb",
  border: "1px solid #1d4ed8",
  color: "#fff",
  cursor: "pointer",
};
