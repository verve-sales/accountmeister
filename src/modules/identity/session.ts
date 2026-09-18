import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { loadActor, type Actor } from "./actor";

export type SessionData = { userId?: string; mode?: "development" | "oidc"; issuedAt?: number; lastSeenAt?: number };

/** Sitzungsdauer (17.4): absolute Höchstdauer und Inaktivitätsgrenze; beide in Sekunden, über Umgebung anpassbar. */
export const SESSION_MAX_AGE_SECONDS = Number(process.env.SESSION_MAX_AGE_SECONDS ?? 12 * 60 * 60);
export const SESSION_IDLE_SECONDS = Number(process.env.SESSION_IDLE_SECONDS ?? 2 * 60 * 60);

export function isSessionExpired(s: SessionData, now = Date.now()): boolean {
  if (!s.userId) return true;
  if (s.issuedAt && now - s.issuedAt > SESSION_MAX_AGE_SECONDS * 1000) return true;
  if (s.lastSeenAt && now - s.lastSeenAt > SESSION_IDLE_SECONDS * 1000) return true;
  return false;
}

function sessionOptions(): SessionOptions {
  const cfg = getConfig();
  return {
    cookieName: "verve_sales_session",
    password: cfg.SESSION_SECRET,
    ttl: SESSION_MAX_AGE_SECONDS,
    cookieOptions: { httpOnly: true, sameSite: "lax", secure: cfg.NODE_ENV === "production", path: "/" },
  };
}

export async function getSession() {
  const store = await cookies();
  return getIronSession<SessionData>(store, sessionOptions());
}

/** Lädt den Akteur frisch aus der Datenbank (kein Rechte-Cache). */
export async function getCurrentActor(): Promise<Actor | null> {
  const session = await getSession();
  if (!session.userId) return null;
  if (isSessionExpired(session)) {
    // Abgelaufene Sitzung: kein Akteur; das Cookie wird beim nächsten Schreibvorgang (Anmeldung) ersetzt
    return null;
  }
  return loadActor(session.userId);
}

/** Aktivität vermerken (gleitende Inaktivitätsgrenze). Nur in Server Actions aufrufen, da Cookies gesetzt werden. */
export async function touchSession(): Promise<void> {
  const session = await getSession();
  if (!session.userId) return;
  session.lastSeenAt = Date.now();
  await session.save();
}
