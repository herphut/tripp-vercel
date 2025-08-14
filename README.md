# tripp-vercel
Tripp AI  - Vercel streaming chat endpoint

# Tripp — HerpHut AI Reptile Assistant 🦎

Tripp is HerpHut’s friendly AI that answers care questions, explains the “why,” and drops pro tips for keepers of all ages.  
This repo contains the **standalone web app** (Vercel-ready) with a minimal chat UI and a secure serverless API route that talks to OpenAI.

> TL;DR: Clone → set env vars → `npm run dev` → deploy to Vercel. No secrets in the browser. Ever.

---

## Features
- ⚡ Minimal, fast chat UI (mobile-friendly)
- 🔐 Server-side API route (no client-side keys)
- 🧰 Drop-in embed snippet for WordPress or any site
- 🪪 Optional rate limiting + basic abuse protection
- 🚀 One-click Vercel deploy via GitHub

---

## Tech Stack
- **Next.js** (App Router or Pages Router — either works)
- **Node 18+**
- **Vercel** (serverless functions)
- **OpenAI API** (model configurable via env)

---

## Prerequisites
- Node.js 18+ and npm (or pnpm/yarn)
- OpenAI API key
- GitHub account (for CI/deploy)
- Vercel account (for hosting)

---

## Getting Started (Local)

```bash
git clone https://github.com/<you>/tripp-vercel.git
cd tripp-vercel
cp .env.example .env.local
npm install
npm run dev
