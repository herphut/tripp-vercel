// app/api/_lib/identity.ts
import "server-only";
import { NextRequest } from "next/server";
import { verifyJwtRS256 } from "@/app/api/_lib/jwtVerify";

export async function getIdentity(req: NextRequest): Promise<{
  user_id: string | null;
  client_id: string;         // always set
  session_id: string | null; // from body or cookie
  anon: boolean;
}> {
  // 1) client id: header -> query -> default
  const client_id =
    req.headers.get("x-client-id") ||
    new URL(req.url).searchParams.get("client_id") ||
    "webchat";

  // 2) user id from HH_ID_TOKEN if present/valid
  let user_id: string | null = null;
  try {
    const tok = req.cookies.get("HH_ID_TOKEN")?.value;
    if (tok) {
      const { payload } = await verifyJwtRS256(tok);
      const sub = String(payload.sub || "");
      user_id = sub || null;
    }
  } catch {
    user_id = null;
  }

  // 3) session id (soft cookie for anon, or body param)
  const softSid =
    req.cookies.get("SESSION_ID")?.value ||
    req.cookies.get("ANON_SESSION_ID")?.value ||
    null;

  return {
    user_id,
    client_id,
    session_id: softSid,
    anon: !user_id,
  };
}
