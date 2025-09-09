'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

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
        "Hi! I’m Tripp. You're chatting with the new HerpHut AI. How can I help today?",
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as LocalChatMessage[];
        if (Array.isArray(parsed) && parsed.length) {
          setMessages(parsed);
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Persist to localStorage whenever messages change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      /* ignore */
    }
  }, [messages]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    const next = [...messages, { role: 'user', content: trimmed as string }];
    setMessages(next);
    setInput('');
    setSending(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = (await res.json()) as { reply: string };
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            "Hmm… I had trouble reaching my brain. Please try again in a moment.",
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="min-h-[100svh] w-full bg-neutral-100 flex items-center justify-center p-4">
      <div className="w-full max-w-3xl">
        <div className="mb-3 text-black font-semibold text-xl">
          Chat with Tripp
        </div>

        {/* Chat window */}
        <div
          ref={scrollRef}
          className="h-[65vh] overflow-y-auto rounded-2xl border border-neutral-300 bg-white shadow-sm p-4"
        >
          <ul className="space-y-4">
            {messages.map((m, i) => (
              <li key={i} className="flex">
                {m.role === 'assistant' ? (
                  <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-neutral-100 border border-neutral-300 px-4 py-3 text-[15px] leading-relaxed text-neutral-900">
                    {m.content}
                  </div>
                ) : (
                  <div className="ml-auto max-w-[85%] rounded-2xl rounded-tr-md bg-blue-50 border border-blue-200 px-4 py-3 text-[15px] leading-relaxed text-neutral-900">
                    {m.content}
                  </div>
                )}
              </li>
            ))}

            {/* Thinking indicator */}
            {sending && (
              <li className="flex">
                <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-neutral-100 border border-neutral-300 px-4 py-3">
                  <span
                    className="text-sm text-neutral-700 animate-pulse"
                    aria-live="polite"
                    aria-busy="true"
                  >
                    Tripp is thinking…
                  </span>
                </div>
              </li>
            )}
          </ul>
        </div>

        {/* Composer */}
        <form onSubmit={onSubmit} className="mt-3 flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message…"
            className="flex-1 h-11 rounded-xl border border-neutral-300 bg-white px-3 text-[15px] text-neutral-900 placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-blue-400"
            aria-label="Type your message"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="h-11 px-4 rounded-xl bg-blue-600 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700 transition"
          >
            Send
          </button>
        </form>

        {/* Small helper actions */}
        <div className="mt-2 flex gap-3">
          <button
            className="text-sm text-neutral-600 underline-offset-2 hover:underline"
            onClick={() => {
              setMessages([]);
              localStorage.removeItem(STORAGE_KEY);
            }}
          >
            Clear chat
          </button>
          <button
            className="text-sm text-neutral-600 underline-offset-2 hover:underline"
            onClick={() => {
              // Seed a fresh greeting
              setMessages([
                {
                  role: 'assistant',
                  content:
                    "Hi! I’m Tripp. You're chatting with the new HerpHut AI. How can I help today?",
                },
              ]);
            }}
          >
            Reset greeting
          </button>
        </div>
      </div>
    </div>
  );
}
