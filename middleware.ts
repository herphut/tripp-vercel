// middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Public routes that never require auth:
const PUBLIC_PREFIXES = [
  "/",
  "/sso/callback",
  "/api/auth/wp",
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
  "/offline", // make offline page itself public
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 🔒 GLOBAL OFFLINE KILL-SWITCH
  // If TRIPP_OFFLINE === "true", everyone gets rewritten to /offline
  // except static assets and the /offline page itself.
  if (process.env.TRIPP_OFFLINE === "true") {
    const isStatic =
      pathname.startsWith("/_next") || pathname.startsWith("/assets");

    const isOfflinePage =
      pathname === "/offline" || pathname.startsWith("/offline/");

    if (!isStatic && !isOfflinePage) {
      const url = req.nextUrl.clone();
      url.pathname = "/offline";
      return NextResponse.rewrite(url);
    }

    // Allow static assets and /offline to load normally
    return NextResponse.next();
  }

  // ⬇️ Existing SSO logic stays the same ⬇️

  // Skip Next internal assets and allowed public paths
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/assets") ||
    PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))
  ) {
    return NextResponse.next();
  }

  // If we already have a session cookie, continue.
  const session = req.cookies.get("tripp_session")?.value;
  if (session) return NextResponse.next();

  // Not logged in → bounce through WP authorize; if WP session exists, user returns instantly with a token.
  const authorize = new URL("https://herphut.com/wp-json/herphut-sso/v1/authorize");
  authorize.searchParams.set("redirect_uri", "https://tripp.herphut.com/sso/callback");
  // Optional: remember where they were going
  if (pathname && pathname !== "/") authorize.searchParams.set("state", pathname);

  return NextResponse.redirect(authorize);
}

// Apply middleware to everything except static/internal assets.
export const config = {
  matcher: ["/((?!_next|assets|favicon.ico|robots.txt|sitemap.xml).*)"],
};
