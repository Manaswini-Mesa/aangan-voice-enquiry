import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/server/auth/session-token";

// First line of defence: unauthenticated requests to dashboard pages go to /login.
// Every page and API route also re-checks the session (and the user's role) on the server.

const DEMO_FALLBACK_SECRET = "demo-mode-insecure-session-secret-do-not-use-live";

function secret(): string | undefined {
  const s = process.env.AUTH_SECRET?.trim();
  if (s && s.length >= 32) return s;
  return process.env.APP_MODE === "live" ? undefined : DEMO_FALLBACK_SECRET;
}

export async function middleware(req: NextRequest) {
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret());
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!login|api/|_next/|favicon.ico|robots.txt).*)"],
};
