// components/Sidebar.tsx
'use client';

import { useEffect, useState } from 'react';

type Props = {
  authed: boolean;
  memoryEnabled: boolean;
  userId: string | null; 
  onToggleMemoryAction: (next: boolean) => void; // client-side reflect
  onNewChatAction: () => void;
  headerExtra?: React.ReactNode;
};

type Recent = { id: string; title: string; updatedAt?: string | null };

export default function Sidebar({
  authed,
  userId,
  memoryEnabled,
  onToggleMemoryAction,
  onNewChatAction,
  headerExtra,
}: Props) {
  const [recent, setRecent] = useState<Recent[]>([]);
  const [gearOpen, setGearOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // fetch recent sessions only when:
  // - user is authed
  // - memory is enabled (opted in)
  useEffect(() => {
    let stop = false;

    (async () => {
      if (!authed || !memoryEnabled) {
        setRecent([]);
        return;
      }

      try {
        const r = await fetch('/api/sessions/recent', {
          credentials: 'include',
          cache: 'no-store',
            headers: {
    'x-user-id': userId ? String(userId) : '',
  },
        });
        const j = await r.json().catch(() => ({ items: [] }));
        if (!stop) setRecent(Array.isArray(j.items) ? j.items : []);
      } catch {
        if (!stop) setRecent([]);
      }
    })();

    return () => {
      stop = true;
    };
  }, [authed, memoryEnabled]);

  // listen for refresh events triggered elsewhere (new chat, send, etc.)
  // but only refresh if authed + memoryEnabled
  useEffect(() => {
    async function doFetch() {
      try {
        const r = await fetch('/api/sessions/recent', {
          credentials: 'include',
          cache: 'no-store',  headers: {
    'x-user-id': userId ? String(userId) : '',
  },

        });
        const j = await r.json().catch(() => ({ items: [] }));
        setRecent(Array.isArray(j.items) ? j.items : []);
      } catch {
        setRecent([]);
      }
    }

    function refreshRecents() {
      if (!authed || !memoryEnabled) {
        setRecent([]);
        return;
      }
      void doFetch();
    }

    window.addEventListener('tripp:refreshRecents', refreshRecents);
    return () => window.removeEventListener('tripp:refreshRecents', refreshRecents);
  }, [authed, memoryEnabled]);

  async function setMemory(next: boolean) {
    // optimistic reflect in parent
    onToggleMemoryAction(next);

    // if turning memory OFF, immediately clear recents in the UI
    if (!next) {
      setRecent([]);
    }

    try {
      if (authed) {
        setSaving(true);
        await fetch('/api/preferences/memory', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ memory_opt_in: next }),
        });
      }
      localStorage.setItem('tripp:memoryOptIn', String(next));
      window.dispatchEvent(new CustomEvent('tripp:memoryChanged', { detail: next }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside
      style={{
        width: 260,
        borderRight: '1px solid #333',
        padding: 12,
        color: '#fff',
        background: '#121416',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <strong>HerpHut • Tripp</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {headerExtra ?? null}
          <button
            onClick={() => setGearOpen((v) => !v)}
            title="Settings"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: '1px solid #444',
              background: 'transparent',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            ⚙️
          </button>
        </div>
      </div>

      {/* tiny settings popover */}
      {gearOpen && (
        <div
          style={{
            marginTop: 10,
            border: '1px solid #444',
            borderRadius: 12,
            padding: 10,
            background: '#1a1c1f',
          }}
        >
          {authed ? (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <input
                type="checkbox"
                checked={memoryEnabled}
                onChange={(e) => setMemory(e.target.checked)}
                disabled={saving}
              />
              <span>Memory opt-in</span>
            </label>
          ) : (
            <div style={{ opacity: 0.7, fontSize: 13 }}>Sign in to enable memory.</div>
          )}
          <div style={{ marginTop: 10 }}>
            <button
              onClick={onNewChatAction}
              style={{
                border: '1px solid #444',
                borderRadius: 8,
                padding: '6px 10px',
                background: 'transparent',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              + New chat
            </button>
          </div>
        </div>
      )}

      {/* recent sessions (logged-in only, gated by memory toggle) */}
      {authed && (
        <>
          <h4 style={{ marginTop: 16, marginBottom: 8, opacity: 0.8 }}>Recent Sessions</h4>

          {!memoryEnabled ? (
            <div style={{ opacity: 0.7, fontSize: 13 }}>
              Turn on memory in ⚙️ settings to save and revisit your chats with Tripp.
            </div>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'grid',
                gap: 6,
              }}
            >
              {recent.length === 0 && (
                <li style={{ opacity: 0.6, fontSize: 13 }}>No recent chats yet.</li>
              )}
              {recent.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => {
                      window.dispatchEvent(
                        new CustomEvent('tripp:selectSession', { detail: s.id }),
                      );
                    }}
                    title={s.title}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      border: '1px solid #333',
                      borderRadius: 8,
                      padding: '8px 10px',
                      background: '#16191c',
                      color: '#fff',
                      cursor: 'pointer',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s.title || 'New chat'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}
