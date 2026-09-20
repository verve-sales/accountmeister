import { NextResponse } from "next/server";
import { DomainError } from "@/lib/errors";
import { checkRateLimit, LIMITS } from "@/lib/ratelimit";
import { getCurrentActor, touchSession } from "@/modules/identity/session";
import type { Actor } from "@/modules/identity/actor";

export async function requireApiActor(): Promise<Actor | NextResponse> {
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  await touchSession();
  return actor;
}

export function writeLimited(actor: Actor): NextResponse | null {
  const rl = checkRateLimit(`write:${actor.userId}`, LIMITS.write.limit, LIMITS.write.windowMs);
  if (!rl.allowed) return NextResponse.json({ error: `Zu viele Änderungen in kurzer Zeit. Bitte in ${rl.retryAfterSeconds} Sekunden erneut versuchen.` }, { status: 429 });
  return null;
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof DomainError) return NextResponse.json({ error: e.message }, { status: e.httpStatus });
  console.error(e);
  return NextResponse.json({ error: "Unerwarteter Fehler." }, { status: 500 });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const j = (await req.json()) as unknown;
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
