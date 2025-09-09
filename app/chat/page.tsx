'use client';

import { useState, useRef, useEffect, FormEvent } from 'react';

type LocalChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

const STORAGE_KEY = 'tripp-chat-history-v1';

export default function ChatPage() {
  const [messages, setMessages] = useState<LocalChatMessage[]>([
    {
      role: 'assistant',
      content:
        "Hi! I’m Tripp. You’re chatting with the new HerpHut AI. How can I help today?",
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setMessages(JSON.parse(raw));
    } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage: LocalChatMessage = { role: 'user', content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setSending(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...messages, userMessage] }),
      });

      if (!res.ok) throw new Error(`HTTP error! ${res.status}`);
      const data = await res.json();

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: data.reply },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            "Sorry—I’m off basking right now! 🦎☀️ I’ll be back shortly.",
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ maxWidth: '600px', margin: '0 auto', padding: '20px' }}>
      <h2 style={{ textAlign: 'center', fontWeight: 'bold' }}>Chat with Tripp</h2>

      <div
        style={{
          border: '1px solid #ccc',
          borderRadius: '10px',
          padding: '10px',
          minHeight: '400px',
          overflowY: 'auto',
        }}
      >
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              textAlign: m.role === 'user' ? 'right' : 'left',
              margin: '10px 0',
            }}
          >
            <span
              style={{
                display: 'inline-block',
                padding: '10px',
                borderRadius: '15px',
                background: m.role === 'user' ? '#DCF8C6' : '#F1F0F0',
                color: '#000',
              }}
            >
              {m.content}
            </span>
          </div>
        ))}
        <div ref={scrollRef} />
      </div>

      <form
        onSubmit={handleSubmit}
        style={{ position: 'relative', marginTop: '10px' }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your message..."
          style={{
            width: '100%',
            padding: '10px 50px 10px 15px',
            borderRadius: '25px',
            border: '1px solid #ccc',
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={sending}
          style={{
            position: 'absolute',
            right: '5px',
            top: '50%',
            transform: 'translateY(-50%)',
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            border: 'none',
            background: '#22c55e',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <img src="/lizard.svg" alt="Send" width={30} height={30} />
        </button>
      </form>
    </div>
  );
}
