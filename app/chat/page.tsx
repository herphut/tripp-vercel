'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type LocalChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

const STORAGE_KEY = 'tripp-chat-history-v1';

export default function ChatPage() {
  const router = useRouter();

  // 🚦 Redirect safeguard (optional)
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.pathname === '/') {
      router.push('/chat');
    }
  }, [router]);

  const [messages, setMessages] = useState<LocalChatMessage[]>([
    {
      role: 'assistant',
      content: "Hi! I'm Tripp. You're chatting with the new HerpHut AI. How can I help today?",
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setMessages(JSON.parse(raw));
    } catch {}
  }, []);

  // Save to localStorage + auto-scroll
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {}
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');

    const next: LocalChatMessage[] = [
      ...messages,
      { role: 'user' as const, content: text },
    ];
    setMessages(next);
    setSending(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data: { reply: string } = await res.json();
      setMessages(m => [...m, { role: 'assistant' as const, content: data.reply }]);
    } catch {
      setMessages(m => [
        ...m,
        { role: 'assistant', content: "Sorry—out basking for a sec. Try again in a bit. 🦎" },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#0f1113',
        padding: '24px 12px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 900 }}>
          <h2 style={{ textAlign: 'center', marginBottom: '16px', color: '#fff' }}>
            Chat with Tripp
          </h2>

          {/* Chat window */}
          <div
            ref={scrollRef}
            style={{
              height: '65vh',
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
    border: 'none',
    background: 'transparent',
    padding: 0,
    margin: 0,
    cursor: sending ? 'not-allowed' : 'pointer',
    transition: 'transform 0.2s ease, filter 0.2s ease',
  }}
  onMouseEnter={e => {
    (e.currentTarget.firstChild as HTMLElement).style.transform = 'scale(1.2)';
    (e.currentTarget.firstChild as HTMLElement).style.filter =
      'drop-shadow(0 0 6px #22c55e)';
  }}
  onMouseLeave={e => {
    (e.currentTarget.firstChild as HTMLElement).style.transform = 'scale(1)';
    (e.currentTarget.firstChild as HTMLElement).style.filter = 'none';
  }}
>
  <img
    src="/lizard.svg"
    alt="Send"
    style={{ width: 30, height: 30, display: 'block' }}
  />
</button>
</form>
</div>
</div>
</main>
  );
}
