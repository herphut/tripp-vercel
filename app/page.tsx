'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import Sidebar from '../components/Sidebar'; // change to "@/components/Sidebar" if you prefer path alias

type LocalChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export default function ChatPage() {
  const [messages, setMessages] = useState<LocalChatMessage[]>([
    {
      role: 'assistant',
      content:
        "Hi! I'm Tripp. You're chatting with the new HerpHut AI. How can I help today?",
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // auto-scroll only
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setInput('');

    const next: LocalChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setSending(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      });
      if (!res.ok) throw new Error(await res.text());
      // our route returns { text }; older code may return { reply }
      const data: { text?: string; reply?: string } = await res.json();
      const out = data.text ?? data.reply ?? '';
      setMessages(m => [...m, { role: 'assistant', content: out }]);
    } catch {
      setMessages(m => [
        ...m,
        { role: 'assistant', content: 'Sorry—out basking for a sec. Try again in a bit. 🦎' },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#0f1113' }}>
      {/* LEFT: Sidebar (memory opt-in + recent chats) */}
      <Sidebar />

      {/* RIGHT: chat UI */}
      <main
        style={{
          flex: 1,
          padding: '24px 12px',
          boxSizing: 'border-box',
          color: '#fff',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: '100%', maxWidth: 900 }}>
            <h2 style={{ textAlign: 'center', marginBottom: '16px' }}>Chat with Tripp</h2>

            {/* Chat window */}
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
                color: '#fff',
              }}
            >
              {messages.map((m, i) => (
                <div
                  key={i}
                  style={{
                    marginBottom: '8px',
                    textAlign: m.role === 'user' ? 'right' : 'left',
                  }}
                >
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

            {/* Input + Send */}
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
                onChange={e => setInput(e.target.value)}
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
                onMouseEnter={e => {
                  const img = e.currentTarget.querySelector('img') as HTMLElement | null;
                  if (img) img.style.transform = 'scale(1.18)';
                  (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 10px #22c55e';
                }}
                onMouseLeave={e => {
                  const img = e.currentTarget.querySelector('img') as HTMLElement | null;
                  if (img) img.style.transform = 'scale(1)';
                  (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none';
                }}
                onMouseDown={e => {
                  (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(1px)';
                }}
                onMouseUp={e => {
                  (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)';
                }}
              >
                <img
                  src="/lizard.svg"
                  alt="Send"
                  style={{
                    width: 30,
                    height: 30,
                    display: 'block',
                    transition: 'transform 0.2s ease',
                    filter: 'drop-shadow(0 0 0 transparent)',
                  }}
                />
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
