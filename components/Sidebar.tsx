// components/Sidebar.tsx
"use client";

import { useCallback } from "react";

type SidebarProps = {
  headerExtra?: React.ReactNode;
  memoryEnabled?: boolean;
  onToggleMemoryAction?: (next: boolean) => void; // <-- rename
};

export default function Sidebar({
  headerExtra,
  memoryEnabled = false,
  onToggleMemoryAction, // <-- rename
}: SidebarProps) {
  const toggle = useCallback(() => {
    const next = !memoryEnabled;
    onToggleMemoryAction?.(next); // <-- rename usage

    // fire your existing cross-tab + localStorage sync
    const ev = new CustomEvent<boolean>("tripp:memoryChanged", { detail: next });
    window.dispatchEvent(ev);
    try { localStorage.setItem("tripp:memoryOptIn", String(next)); } catch {}
  }, [memoryEnabled, onToggleMemoryAction]);

  return (
    <aside style={{ width: 280, borderRight: "1px solid #333", padding: 12, color: "#fff", background: "#121316", boxSizing: "border-box" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <strong>Sessions</strong>
        <div>{headerExtra}</div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={!!memoryEnabled} onChange={toggle} aria-label="Toggle memory" />
          <span style={{ opacity: 0.85 }}>Memory {memoryEnabled ? "ON" : "OFF"}</span>
        </label>
      </div>

      <div style={{ opacity: 0.6, fontSize: 12 }}>
        Select a session from here…
      </div>
    </aside>
  );
}
