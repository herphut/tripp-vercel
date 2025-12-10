// app/api/_lib/identity.ts
import "server-only";
import { NextRequest } from "next/server";
import { verifyJwtRS256 } from "@/app/api/_lib/jwtVerify";

export async function getIdentity(req: NextRequest): Promise<{
  user_id: string | null;
  client_id: string;         // always set
  session_id: string | null;
  anon: boolean;
  mode: "user" | "anon" | "unknown";
}> {
  // 1) client id: header -> query -> default
  const client_id =
    req.headers.get("x-client-id") ||
    new URL(req.url).searchParams.get("client_id") ||
    "webchat";

  // ✅ 2) HEADER USER FALLBACK (never downgrade once known)
  const headerUid = req.headers.get("x-user-id");
  let user_id: string | null = headerUid || null;

  // 3) JWT USER (authoritative, overrides header if valid)
  try {
    const tok = req.cookies.get("HH_ID_TOKEN")?.value;
    if (tok) {
      const { payload } = await verifyJwtRS256(tok);
      const sub = String(payload.sub || "");
      if (sub) {
        user_id = sub;
      }
    }
  } catch {
    // 🔥 DO NOT clear user_id here (NO DOWNGRADE)
  }

  // 4) session id (soft cookie for anon, or body param)
  const softSid =
    req.cookies.get("SESSION_ID")?.value ||
    req.cookies.get("ANON_SESSION_ID")?.value ||
    null;

  // ✅ 5) Identity mode resolution
  let mode: "user" | "anon" | "unknown" = "unknown";

  if (user_id) mode = "user";
  else if (softSid) mode = "anon";

  return {
    user_id,
    client_id,
    session_id: softSid,
    anon: mode === "anon",
    mode,
  };
}
