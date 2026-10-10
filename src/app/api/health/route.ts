import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { config } from "@/server/env";

export const dynamic = "force-dynamic";

/** Public health check. Reports only coarse status — no versions, hosts or configuration values. */
export async function GET() {
  let database: "ok" | "unavailable" = "unavailable";
  try {
    const db = await getDb();
    await db.query("SELECT 1");
    database = "ok";
  } catch {
    database = "unavailable";
  }
  const body = { status: database === "ok" ? "ok" : "degraded", mode: config().mode, database, time: new Date().toISOString() };
  return NextResponse.json(body, { status: database === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
