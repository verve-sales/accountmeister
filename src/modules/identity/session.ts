import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { loadActor, type Actor } from "./actor";

export type SessionData = { userId?: string; mode?: "development" | "oidc" };

function sessionOptions(): SessionOptions {
  const cfg = getConfig();
  return {
    cookieName: "verve_sales_session",
    password: cfg.SESSION_SECRET,
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
  return loadActor(session.userId);
}
