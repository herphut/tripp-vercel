'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

type LocalChatMessage = { role: 'user' | 'assistant'; content: string };

const STORAGE_KEY = 'tripp-chat-history-v1';

export default function ChatPage() {
  const [messages, setMessages] = useState<LocalChatMessage[]>([
    { role: 'assistant' as const, content: "Hi! I'm Tripp. You’re chatting with the new HerpHut AI. How can I help today?" },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // load/save local history
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setMessages(JSON.parse(raw));
    } catch {}
  }, []);
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
    const next LocalChatMessage[] = [...messages, { role: 'user' as const, content: text }];
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
      setMessages(m => [...m, { role: 'assistant', content: "Sorry—out basking for a sec. Try again in a bit. 🦎" }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', padding: 24, background: '#111', color: '#fff' }}>
      <h2 style={{ textAlign: 'center', marginBottom: 16 }}>Chat with Tripp</h2>

      <div
        ref={scrollRef}
        style={{
          height: '60vh',
          overflowY: 'auto',
          border: '1px solid #777',
          borderRadius: 12,
          padding: 12,
          marginBottom: 12,
          background: '#1a1a1a',
        }}
      >
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              margin: '8px 0',
              display: 'flex',
              justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div
              style={{
                maxWidth: '75%',
                padding: '10px 12px',
                borderRadius: 12,
                background: m.role === 'user' ? '#2a6' : '#eee',
                color: m.role === 'user' ? '#fff' : '#111',
              }}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div style={{ opacity: 0.8, fontStyle: 'italic', marginTop: 8, color: '#ccc' }}>
            Tripp is thinking…
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Type your message…"
          style={{
            flex: 1,
            borderRadius: 999,
            border: '1px solid #888',
            padding: '12px 16px',
            background: '#111',
            color: '#fff',
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={sending}
          style={{
            borderRadius: '999px',
            width: 44,
            height: 44,
            border: 'none',
            background: sending ? '#3a3' : '#4bd964',
            cursor: sending ? 'default' : 'pointer',
          }}
          aria-label="Send"
          title="Send"
        >
          🦎
        </button>
      </form>
    </div>
  );
}
