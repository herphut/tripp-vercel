// @/app/page.tsx
'use client';

import type { FormEvent, ChangeEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import Sidebar from '../components/Sidebar';

type LocalChatMessage = { role: 'user' | 'assistant'; content: string };

// ---------- tiny auth boot helpers ----------
type ExchangeOK = {
  session_id: string;
  user_id: string | null;
  guest?: boolean;
  tier?: string;
  expires_at: string;
};

type StatusOK = {
  authenticated: boolean;
  userId: string | null;
  memoryOptIn: boolean;
};

async function exchange(): Promise<ExchangeOK> {
  const r = await fetch('/api/auth/exchange', {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  // If JWT is invalid, server may still 401 with a refresh link
  if (r.status === 401) {
    const { refresh } = await r.json().catch(() => ({}));
    if (refresh) window.location.href = refresh;
    throw new Error('needs_refresh');
  }
  if (!r.ok) throw new Error(`exchange failed: ${r.status}`);
  return r.json();
}

async function fetchStatus(): Promise<StatusOK> {
  const r = await fetch('/api/user/status', {
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) return { authenticated: false, userId: null, memoryOptIn: false };
  const j = (await r.json()) as StatusOK;
  return {
    authenticated: !!j.authenticated,
    userId: j.userId ?? null,
    memoryOptIn: !!j.memoryOptIn,
  };
}
// --------------------------------------------

const LOCAL_HISTORY_LIMIT = 30;
function buildRollingWindow(
  local: { role: 'user' | 'assistant'; content: string }[],
  newestUser: string
) {
  const combined = [...local, { role: 'user' as const, content: newestUser }];
  return combined.slice(-LOCAL_HISTORY_LIMIT);
}

function NewChatLink({ onClick, visible }: { onClick: () => void; visible: boolean }) {
  if (!visible) return null;
  return (
    <button
      onClick={onClick}
      className="text-sm underline underline-offset-2 opacity-80 hover:opacity-100"
      aria-label="Start a new chat"
    >
      + New chat
    </button>
  );
}

export default function ChatPage() {
  const [messages, setMessages] = useState<LocalChatMessage[]>([
    { role: 'assistant', content: "Hi! I'm Tripp. You're chatting with the new HerpHut AI. How can I help today?" },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  // image upload state
  const [uploading, setUploading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // boot state
  const [ready, setReady] = useState(false);
  const [bootErr, setBootErr] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [memoryEnabled, setMemoryEnabled] = useState(false);

  
   // derive auth + upload rights
  const authed = !!userId;
  const canUploadImages = authed;

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Load transcript when a session is selected in the sidebar
  useEffect(() => {
    async function onSelect(e: Event) {
      const id = (e as CustomEvent<string>).detail;
      setSessionId(id);

      try {
        const r = await fetch(`/api/history?session_id=${encodeURIComponent(id)}`, {
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        const rows = await r.json();
        if (Array.isArray(rows) && rows.length) {
          const ms = rows.map((m: any) => ({
            role: (m.role === 'system' ? 'assistant' : m.role) as 'user' | 'assistant',
            content: String(m.content ?? ''),
          })) as LocalChatMessage[];
          setMessages(ms);
        } else {
          setMessages([{ role: 'assistant', content: 'Fresh slate for this chat. What’s on your mind?' }]);
        }
      } catch {
        setMessages([{ role: 'assistant', content: 'Couldn’t load that chat. Try again in a bit.' }]);
      }
    }
    window.addEventListener('tripp:selectSession', onSelect as EventListener);
    return () => window.removeEventListener('tripp:selectSession', onSelect as EventListener);
  }, []);

  // Reflect memory toggle changes (and cross-tab via localStorage)
  useEffect(() => {
    function onChanged(ev: Event) {
      const next = (ev as CustomEvent<boolean>).detail;
      setMemoryEnabled(!!next);
    }
    function onStorage(ev: StorageEvent) {
      if (ev.key === 'tripp:memoryOptIn') setMemoryEnabled(ev.newValue === 'true');
    }
    window.addEventListener('tripp:memoryChanged', onChanged as EventListener);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('tripp:memoryChanged', onChanged as EventListener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // --------- BOOT: exchange + status ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const x = await exchange(); // sets HH_SESSION_ID cookie server-side
        if (cancelled) return;
        setSessionId(x.session_id);
        setUserId(x.user_id ?? null);

        const st = await fetchStatus();
        if (cancelled) return;
        setMemoryEnabled(!!st.memoryOptIn);
        localStorage.setItem('tripp:memoryOptIn', String(!!st.memoryOptIn));
      } catch (e: any) {
        setBootErr(e?.message || 'boot failed');
      } finally {
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  // --------------------------------------------

  function handleNewChat() {
    setMessages([{ role: 'assistant', content: "Fresh slate! What's on your mind?" }]);
  }

  // open file picker
  function pickImage() {
    fileRef.current?.click();
  }

  // upload to /api/upload
  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    if (!canUploadImages) return;
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await fetch('/api/upload', { method: 'POST', body: form, credentials: 'include' });
      if (!r.ok) throw new Error(await r.text());
      const j = await r.json();
      setImageUrl(j.url || j.downloadUrl || null);
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: 'Upload failed. Please try another image.' }]);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function clearImage() {
    setImageUrl(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if ((!text && !imageUrl) || sending) return; // require text or image
    if (!sessionId) {
      setMessages((m) => [...m, { role: 'assistant', content: 'No session yet—try again in a second.' }]);
      return;
    }

    setInput('');
    const optimisticText =
      imageUrl && text ? `${text}\n\n(Attached image: ${imageUrl})` :
      imageUrl ? `(Attached image: ${imageUrl})` : text;

    const optimistic: LocalChatMessage[] = [...messages, { role: 'user', content: optimisticText }];
    setMessages(optimistic);
    setSending(true);

    try {
      const payload =
        memoryEnabled
          ? {
              session_id: sessionId,
              user_id: userId,
              messages: [{ role: 'user', content: text || '(image attached)' }],
              image_url: canUploadImages ? (imageUrl || undefined) : undefined,

            }
          : {
              session_id: sessionId,
              user_id: userId,
              messages: buildRollingWindow(
                messages.map((m) => ({ role: m.role, content: m.content })),
                optimisticText
              ),
              image_url: canUploadImages ? (imageUrl || undefined) : undefined,

            };

      const res = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());

      const data = await res.json();
      const serverMsgs =
        Array.isArray(data?.messages)
          ? data.messages.map((m: any) => ({
              role: m.role as 'user' | 'assistant',
              content: String(m.content ?? ''),
            }))
          : [{ role: 'assistant', content: String(data?.reply ?? data?.text ?? '') }];

      setMessages(serverMsgs);
    } catch {
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: 'Sorry—out basking for a sec. Try again in a bit. 🦎' },
      ]);
    } finally {
      setSending(false);
      setImageUrl(null);
    }
  }

  // simple boot UX
  if (!ready) return <div style={{ padding: 24, color: '#fff' }}>Starting Tripp…</div>;
  if (bootErr) return <div style={{ padding: 24, color: '#fff' }}>Auth error: {bootErr}</div>;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#0f1113' }}>
      <Sidebar headerExtra={<NewChatLink onClick={handleNewChat} visible={memoryEnabled} />} />

      <main style={{ flex: 1, padding: '24px 12px', boxSizing: 'border-box', color: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: '100%', maxWidth: 900 }}>
            <small style={{ opacity: 0.7 }}>
              session: {sessionId?.slice(0, 8)}… • user: {userId ?? 'anon'} • memory: {memoryEnabled ? 'ON' : 'OFF'}
            </small>

            <h2 style={{ textAlign: 'center', margin: '12px 0 16px' }}>Chat with Tripp</h2>

            <div
              ref={scrollRef}
              style={{
                height: 'calc(100vh - 220px)',
                overflowY: 'auto',
                border: '1px solid #444',
                borderRadius: '12px',
                padding: '12px',
                marginBottom: '12px',
                background: '#1a1c1f',
              }}
            >
              {messages.map((m, i) => (
                <div key={i} style={{ marginBottom: '8px', textAlign: m.role === 'user' ? 'right' : 'left' }}>
                  <div
                    style={{
                      display: 'inline-block',
                      padding: '8px 12px',
                      borderRadius: '12px',
                      background: m.role === 'user' ? '#22c55e' : '#333',
                      color: m.role === 'user' ? '#000' : '#fff',
                      maxWidth: 720,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {m.content}
                  </div>
                </div>
              ))}
            </div>

            <form
  onSubmit={onSubmit}
  style={{
    display: 'flex',
    alignItems: 'center',
    border: '1px solid #444',
    borderRadius: '9999px',
    padding: '4px 8px',
    background: '#1a1c1f',
    gap: 8,
  }}
>
  {/* Hidden file input (only render if allowed) */}
  {canUploadImages && (
    <input
      ref={fileRef}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      style={{ display: 'none' }}
      onChange={onFileChange}
    />
  )}

  {/* Upload button (only render if allowed) */}
  {canUploadImages && (
    <button
      type="button"
      onClick={pickImage}
      disabled={sending || uploading}
      title={uploading ? 'Uploading…' : 'Upload image'}
      style={{
        width: 36,
        height: 36,
        borderRadius: '50%',
        border: '1px solid rgba(255,255,255,0.35)',
        background: 'transparent',
        color: '#fff',
        display: 'grid',
        placeItems: 'center',
        opacity: sending ? 0.6 : 1,
        cursor: sending ? 'not-allowed' : 'pointer',
      }}
    >
      {uploading ? '…' : '📷'}
    </button>
  )}

  {/* tiny preview pill (only if allowed and present) */}
  {canUploadImages && imageUrl && (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: '#262a2f',
        border: '1px solid #3a3f46',
        borderRadius: 999,
        padding: '3px 8px',
        maxWidth: 220,
      }}
      title={imageUrl}
    >
      <img
        src={imageUrl}
        alt="preview"
        style={{ width: 24, height: 24, objectFit: 'cover', borderRadius: 6 }}
      />
      <span
        style={{
          fontSize: 12,
          opacity: 0.8,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        image attached
      </span>
      <button
        type="button"
        onClick={clearImage}
        aria-label="Remove image"
        style={{
          background: 'transparent',
          border: 'none',
          color: '#aaa',
          cursor: 'pointer',
          fontSize: 14,
        }}
      >
        ×
      </button>
    </span>
  )}

  <input
    type="text"
    value={input}
    onChange={(e) => setInput(e.target.value)}
    placeholder={imageUrl ? 'Add a question about the image…' : 'Type your message...'}
    disabled={sending}
    style={{
      flex: 1,
      border: 'none',
      outline: 'none',
      background: 'transparent',
      color: '#fff',
      padding: '8px',
    }}
  />

  <button
    type="submit"
    disabled={sending}
    style={{
      width: 44,
      height: 44,
      borderRadius: '50%',
      border: '1px solid rgba(255,255,255,0.35)',
      background: 'linear-gradient(180deg, #34d399, #16a34a)',
      display: 'grid',
      placeItems: 'center',
      padding: 0,
      margin: 0,
      cursor: sending ? 'not-allowed' : 'pointer',
      transition: 'box-shadow 0.2s ease, transform 0.05s ease',
    }}
    onMouseEnter={(e) => {
      const img = e.currentTarget.querySelector('img') as HTMLElement | null;
      if (img) img.style.transform = 'scale(1.18)';
      (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 10px #22c55e';
    }}
    onMouseLeave={(e) => {
      const img = e.currentTarget.querySelector('img') as HTMLElement | null;
      if (img) img.style.transform = 'scale(1)';
      (e.currentTarget as HTMLButtonElement | any).style.boxShadow = 'none';
    }}
    onMouseDown={(e) => ((e.currentTarget as HTMLButtonElement).style.transform = 'translateY(1px)')}
    onMouseUp={(e) => ((e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)')}
  >
    <img
      src="/lizard.svg"
      alt="Send"
      style={{ width: 30, height: 30, display: 'block', transition: 'transform 0.2s ease' }}
    />
  </button>
</form>
</div>
</div>
</main>
</div>
);
}
