'use client';

import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import Sidebar from '../components/Sidebar';

type LocalChatMessage = { role: 'user' | 'assistant'; content: string };

// ---------- tiny auth boot helpers ----------
type ExchangeOK = { session_id: string; user_id: string; expires_at: string };
async function exchange(): Promise<ExchangeOK> {
  const r = await fetch('/api/auth/exchange', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
  });
  if (r.status === 401) {
    // Expect { refresh: "https://herphut.com/?hh_sso_refresh=1&return=..." }
    const { refresh } = await r.json().catch(() => ({}));
    if (refresh) window.location.href = refresh;
    throw new Error('needs refresh');
  }
  if (!r.ok) throw new Error(`exchange failed: ${r.status}`);
  return r.json();
}

async function getMemoryPref(): Promise<{ memoryOptIn: boolean; scope?: string }> {
  const r = await fetch('/api/preferences/memory', {
    method: 'GET',
    credentials: 'include',
  });
  if (!r.ok) throw new Error(`pref failed: ${r.status}`);
  return r.json();
}
// --------------------------------------------

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

  // boot state
  const [ready, setReady] = useState(false);
  const [bootErr, setBootErr] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [memoryEnabled, setMemoryEnabled] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Sidebar session select (unchanged)
  useEffect(() => {
    function onSelect(e: Event) {
      const id = (e as CustomEvent<string>).detail;
      console.log('selected session', id);
      // optionally load that session's messages here
    }
    window.addEventListener('tripp:selectSession', onSelect as EventListener);
    return () => window.removeEventListener('tripp:selectSession', onSelect as EventListener);
  }, []);

  // --------- BOOT: exchange + memory pref ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const x = await exchange(); // sets HH_SESSION_ID cookie + returns ids
        if (cancelled) return;
        setSessionId(x.session_id);
        setUserId(x.user_id);

        const pref = await getMemoryPref();
        if (cancelled) return;
        setMemoryEnabled(!!pref.memoryOptIn);
      } catch (e: any) {
        setBootErr(e?.message || 'boot failed');
      } finally {
        setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  // -------------------------------------------------

  function handleNewChat() {
    setMessages([{ role: 'assistant', content: "Fresh slate! What's on your mind?" }]);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    if (!sessionId) {
      setMessages((m) => [...m, { role: 'assistant', content: 'No session yet—try again in a second.' }]);
      return;
    }

    setInput('');
    const optimistic: LocalChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(optimistic);
    setSending(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'include', // ensure cookies go with the request
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          user_id: userId,
          messages: [{ role: 'user', content: text }], // server only needs latest turn
          memoryEnabled, // let server decide whether to persist
        }),
      });
      if (!res.ok) throw new Error(await res.text());

      // Our route returns { messages: {role,content,created_at}[], diag: {...} }
      const data = await res.json();
      const serverMsgs =
        Array.isArray(data?.messages)
          ? data.messages.map((m: any) => ({ role: m.role as 'user' | 'assistant', content: String(m.content ?? '') }))
          : [{ role: 'assistant', content: String(data?.reply ?? data?.text ?? '') }];

      setMessages(serverMsgs);
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: 'Sorry—out basking for a sec. Try again in a bit. 🦎' }]);
    } finally {
      setSending(false);
    }
  }

  // simple boot UX
  if (!ready) return <div style={{ padding: 24, color: '#fff' }}>Starting Tripp…</div>;
  if (bootErr) return <div style={{ padding: 24, color: '#fff' }}>Auth error: {bootErr}</div>;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#0f1113' }}>
      {/* LEFT: Sidebar — place NewChatLink just above recent chats */}
      <Sidebar
        headerExtra={<NewChatLink onClick={handleNewChat} visible={memoryEnabled} />}
      />

      {/* RIGHT: Chat UI */}
      <main style={{ flex: 1, padding: '24px 12px', boxSizing: 'border-box', color: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: '100%', maxWidth: 900 }}>
            {/* tiny debug header */}
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
              }}
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type your message..."
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
