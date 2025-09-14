// middleware.ts (root) backup
import { NextRequest, NextResponse } from "next/server";
import { burstLimit } from "./src/lib/rateLimits";
import { CLIENTS } from "./src/lib/clients";

// Only guard endpoints that need it
export const config = {
  matcher: [
    "/api/chat",
    "/api/session",
    "/api/tripp/:path*",
    "/api/clear-memory",
    "/api/hello",
    // NOTE: /api/health intentionally NOT matched
  ],
};

// CORS allowlist: comma-separated origins in env
const ORIGINS = (process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Example wordlists — customize for your app
const BAD = ["f-bomb", "c-bomb", "slur1", "slur2"];
const INJ = [
  "ignore previous instructions",
  "reveal system prompt",
  "developer mode",
  "bypass safety",
];

function setCors(res: NextResponse, origin: string) {
  if (origin && ORIGINS.includes(origin)) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
  }
  res.headers.set("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,x-client-id"
  );
  res.headers.set("Access-Control-Allow-Credentials", "true");
  return res;
}

export async function middleware(req: NextRequest) {
  console.log("MW:",
    req.nextUrl.pathname);

  // ⛑️ Bypass health (no auth/limits/CORS needed)
  if (req.nextUrl.pathname === "/api/health") {
    console.log("MW BYPASS /api/hea;th");
    return NextResponse.next();
  }

  const origin = req.headers.get("origin") || "";

  // Preflight
  if (req.method === "OPTIONS") {
    return setCors(new NextResponse(null, { status: 204 }), origin);
  }

  // Origin gate
  if (ORIGINS.length && origin && !ORIGINS.includes(origin)) {
    return NextResponse.json({ error: "Forbidden origin" }, { status: 403 });
  }

  // 🔖 Identify/validate client (default to public web widget)
  const incomingClientId = req.headers.get("x-client-id") ?? "web-widget-v1";
  if (!CLIENTS[incomingClientId]) {
    return setCors(
      NextResponse.json({ error: "Unknown client" }, { status: 401 }),
      origin
    );
  }

  // Rate limit (use x-forwarded-for in serverless)
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
  const key = `rl:${incomingClientId}:${ip}:${req.nextUrl.pathname}`;
  const { allowed } = await burstLimit(key);
  if (!allowed) {
    return setCors(
      NextResponse.json({ error: "Rate limit" }, { status: 429 }),
      origin
    );
  }

  // Lightweight JSON guardrails (only if body present)
  if (req.method !== "GET") {
    try {
      const body = await req.clone().json();
      if (body?.messages) {
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const user = msgs.find((m: any) => m?.role === "user");
        if (!user?.content || typeof user.content !== "string") {
          return setCors(
            NextResponse.json({ error: "Missing user content" }, { status: 400 }),
            origin
          );
        }
        const lower = String(user.content).toLowerCase();
        if (BAD.some((w) => lower.includes(w))) {
          return setCors(
            NextResponse.json({ error: "Blocked terms" }, { status: 400 }),
            origin
          );
        }
        if (INJ.some((w) => lower.includes(w))) {
          return setCors(
            NextResponse.json({ error: "Disallowed instruction" }, { status: 400 }),
            origin
          );
        }
      }
    } catch {
      // non-JSON bodies still allowed for other endpoints
    }
  }

  // Pass through normalized client id
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-client-id", incomingClientId);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("x-tripp-sanitized", "1");
  return setCors(res, origin);
}
