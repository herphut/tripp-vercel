// app/api/auth/exchange/route.ts
export const runtime = "nodejs";
import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { verifyJwtRS256 } from "@/app/api/_lib/jwtVerify";

const CLIENT_ID = "webchat";
const TTL_MIN = Number(process.env.TRIPP_SESSION_TTL_MIN || 1440);   // 24h
const GUEST_TTL_MIN = Number(process.env.TRIPP_GUEST_TTL_MIN || 60); // 60m

type ExchangeOK = {
  session_id: string;        // we no longer use this, but keep shape for the frontend
  user_id: string | null;
  guest?: boolean;
  tier?: string;
  expires_at: string;
};

export async function POST(req: NextRequest) {
  const now = new Date();

  // Try to read the JWT from cookie (set by WordPress SSO)
  const cookieToken = req.cookies.get("HH_ID_TOKEN")?.value ?? null;

  // If no token at all → treat as guest
  if (!cookieToken) {
    const expiresAt = new Date(now.getTime() + GUEST_TTL_MIN * 60_000);
    const payload: ExchangeOK = {
      session_id: "", // not used now; real sessions come from /api/session
      user_id: null,
      guest: true,
      tier: "guest",
      expires_at: expiresAt.toISOString(),
    };
    return NextResponse.json(payload, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // If we have a token, try to verify it
  try {
    const { payload } = await verifyJwtRS256(cookieToken);

    const userId = String(payload.sub || "");
    const tier = (payload.tier as string) || "free";

    // Prefer JWT exp if present; otherwise default TTL
    let expiresAt: Date;
    if (typeof payload.exp === "number") {
      // exp is in seconds since epoch
      expiresAt = new Date(payload.exp * 1000);
    } else {
      expiresAt = new Date(now.getTime() + TTL_MIN * 60_000);
    }

    const body: ExchangeOK = {
      session_id: "", // we no longer bind Tripp's session to exchange()
      user_id: userId,
      guest: false,
      tier,
      expires_at: expiresAt.toISOString(),
    };

    return NextResponse.json(body, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Client-Id": CLIENT_ID,
      },
    });
  } catch (e: any) {
    // Invalid / expired JWT → tell the client, which will treat as "needs_refresh"
    return NextResponse.json(
      {
        error: "jwt_invalid",
        reason: String(e?.message || e),
        // You *can* add `refresh` here later if you want to redirect to a login URL.
        // For now, the frontend will swallow `needs_refresh` and treat the user as anon.
      },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}