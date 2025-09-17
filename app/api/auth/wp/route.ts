import { NextRequest, NextResponse } from "next/server";
import { verifyWPToken } from "@/lib/jwks";
import { SignJWT } from "jose";

export async function POST(req: NextRequest) {
  const { token } = await req.json();
  if (!token) return NextResponse.json({ error: "Missing token" }, { status: 400 });

  try {
    const payload = await verifyWPToken(token);
    const appToken = await new SignJWT({
      sub: payload.sub, email: payload.email, name: payload.name,
      roles: payload.roles, tier: payload.tier
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(new TextEncoder().encode(process.env.APP_SESSION_SECRET!));

    const res = NextResponse.json({ ok: true });
    res.cookies.set("tripp_session", appToken, {
      httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 60*60*24*7
    });
    return res;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
}
