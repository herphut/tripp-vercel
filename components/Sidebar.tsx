// components/Sidebar.tsx
"use client";
import { useEffect, useState } from "react";

export default function Sidebar() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then(setSessions)
      .finally(() => setLoading(false));
  }, []);

  async function clearMemory() {
    await fetch("/api/clear-memory", { method: "POST" });
    setSessions([]);
    alert("Tripp’s memory has been cleared 🦎");
  }

  return (
    <aside className="w-64 bg-gray-900 text-white p-4 flex flex-col">
      <h2 className="text-lg font-bold mb-2">Recent Chats</h2>
      {loading && <p>Loading…</p>}
      {!loading && sessions.length === 0 && (
        <p className="text-gray-400">No chats yet.</p>
      )}
      <ul className="flex-1 space-y-2 overflow-y-auto">
        {sessions.map((s) => (
          <li key={s.id}>
            <a
              href={`/chat?s=${s.id}`}
              className="block p-2 rounded hover:bg-gray-700"
            >
              {s.title || "Untitled chat"}
            </a>
          </li>
        ))}
      </ul>
      <button
        onClick={clearMemory}
        className="mt-4 py-2 px-3 bg-red-600 rounded hover:bg-red-500"
      >
        Clear Memory
      </button>
    </aside>
  );
}
