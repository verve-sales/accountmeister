import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { Actor } from "@/modules/identity/actor";

/**
 * e72: Die vier einstellbaren Fristen (Verwaltung › Fristen). Bewusst nur diese vier – alles andere bleibt fest.
 * Die Werte liegen am Arbeitsbereich; gelesen wird synchron aus einem Zwischenspeicher, der je Anfrage (Layout),
 * im Hintergrunddienst und beim Speichern aufgefrischt wird. Es gibt genau einen Arbeitsbereich.
 */
export type Deadlines = { renewalLeadDays: number; checkinDays: number; offerFollowUpDays: number; offerExpiryDays: number };
export const DEADLINE_DEFAULTS: Deadlines = { renewalLeadDays: 90, checkinDays: 42, offerFollowUpDays: 10, offerExpiryDays: 60 };
export const DEADLINE_FIELDS: { key: keyof Deadlines; label: string; help: string; min: number; max: number }[] = [
  { key: "renewalLeadDays", label: "Verlängerung klären – Tage vor Einsatzende", help: "Ab dann erscheint die Verlängerung beim BD.", min: 30, max: 180 },
  { key: "checkinDays", label: "Kunden-Check-in – Abstand in Tagen", help: "Nach dem letzten Gespräch; gilt für neu berechnete Termine.", min: 14, max: 120 },
  { key: "offerFollowUpDays", label: "Angebot ohne Antwort – nachfassen nach Tagen", help: "Erscheint dann im Abgleich unter „Angebot & Bestellung“.", min: 3, max: 60 },
  { key: "offerExpiryDays", label: "Angebot ohne Antwort – absagen oder nachfassen nach Tagen", help: "Ab dann hervorgehoben.", min: 14, max: 365 },
];

let current: Deadlines = { ...DEADLINE_DEFAULTS };
let loadedAt = 0;

function clean(raw: unknown): Deadlines {
  const o = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
  const out = { ...DEADLINE_DEFAULTS };
  for (const f of DEADLINE_FIELDS) {
    const n = Number(o[f.key]);
    if (Number.isInteger(n) && n >= f.min && n <= f.max) out[f.key] = n;
  }
  return out;
}

/** Aktuelle Fristen (synchron, aus dem Zwischenspeicher). */
export const deadlines = (): Deadlines => current;

export async function loadDeadlines(force = false): Promise<Deadlines> {
  if (!force && Date.now() - loadedAt < 15_000) return current;
  const ws = await db.query.workspaces.findFirst({ columns: { settings: true } });
  current = clean((ws?.settings as Record<string, unknown> | undefined)?.deadlines);
  loadedAt = Date.now();
  return current;
}

export async function saveDeadlines(actor: Actor, raw: Record<string, unknown>): Promise<Deadlines> {
  if (!actor.roles.has("ADMIN") && !actor.roles.has("CEO")) throw new ForbiddenError("Fristen stellt die Geschäftsführung oder die Betriebsverwaltung ein.");
  const next = { ...DEADLINE_DEFAULTS };
  for (const f of DEADLINE_FIELDS) {
    const n = Number(String(raw[f.key] ?? "").trim());
    if (!Number.isInteger(n) || n < f.min || n > f.max) throw new ValidationError(`${f.label}: bitte eine ganze Zahl zwischen ${f.min} und ${f.max}.`);
    next[f.key] = n;
  }
  if (next.offerExpiryDays <= next.offerFollowUpDays) throw new ValidationError("Die zweite Angebotsfrist muss länger sein als die erste.");
  const ws = await db.query.workspaces.findFirst({ where: eq(schema.workspaces.id, actor.workspaceId) });
  await db.update(schema.workspaces).set({ settings: { ...((ws?.settings as Record<string, unknown>) ?? {}), deadlines: next }, updatedAt: new Date() }).where(eq(schema.workspaces.id, actor.workspaceId));
  current = next;
  loadedAt = Date.now();
  return next;
}

/** Nur für Tests: Zwischenspeicher zurücksetzen. */
export function resetDeadlinesForTest(v: Partial<Deadlines> = {}) { current = { ...DEADLINE_DEFAULTS, ...v }; loadedAt = Date.now(); }
