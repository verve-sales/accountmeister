import { getConfig } from "@/lib/config";
import { generateOverdueNotifications } from "@/modules/work/service";
import { dispatchDigests, dispatchPendingEmails } from "./mailer";
import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";

/**
 * Hintergrundtakt im App-Prozess (Etappe 27), gestartet über src/instrumentation.ts:
 * jede Minute Sofort-Mails, stündlich Überfällig-Hinweise, einmal täglich zur MAIL_DIGEST_HOUR den Digest.
 * Läuft nur einmal je Prozess; Fehler werden protokolliert und brechen den Takt nicht ab.
 */
const g = globalThis as unknown as { __amWorker?: boolean };

function berlinHourAndDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/** Lauf protokollieren (Heartbeat, Ergebnis, Fehler) – sichtbar unter Verwaltung. Fehler brechen den Takt nicht ab. */
export async function runJob(name: string, fn: () => Promise<Record<string, number>>): Promise<void> {
  const [row] = await db.insert(schema.jobRuns).values({ name }).returning({ id: schema.jobRuns.id });
  try {
    const counts = await fn();
    await db.update(schema.jobRuns).set({ finishedAt: new Date(), ok: true, counts }).where(eq(schema.jobRuns.id, row!.id));
  } catch (e) {
    await db.update(schema.jobRuns).set({ finishedAt: new Date(), ok: false, error: (e as Error).message.slice(0, 500) }).where(eq(schema.jobRuns.id, row!.id));
    console.error(`Hintergrundlauf ${name}`, (e as Error).message);
  }
}

export function startNotificationWorker(): void {
  if (g.__amWorker) return;
  g.__amWorker = true;
  let lastOverdueHour = "";
  let lastDigestDate = "";
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const cfg = getConfig();
      const { date, hour } = berlinHourAndDate();
      const hourKey = `${date}T${hour}`;
      if (hourKey !== lastOverdueHour && hour >= 6) {
        lastOverdueHour = hourKey;
        await runJob("ueberfaellig", async () => ({ hinweise: await generateOverdueNotifications() }));
        // Einsatzregeln (Etappe 29): Catch-ups, fällige Check-ins, Verlängerung – idempotent über Schlüssel
        await runJob("einsatz-regeln", async () => {
          const { ensureCatchups, notifyDueCheckins, ensureRenewalDecisions } = await import("@/modules/engagements/care");
          const { ensureOrdersEnded } = await import("@/modules/health/service");
          const { db } = await import("@/db/client");
          let beendet = 0;
          for (const ws of await db.query.workspaces.findMany({ columns: { id: true } })) beendet += await ensureOrdersEnded(ws.id);
          return { catchups: await ensureCatchups(), checkinHinweise: await notifyDueCheckins(), verlaengerungen: await ensureRenewalDecisions(), auftraegeBeendet: beendet };
        });
        // Moco-Abgleich (Etappe 31): stündlich als Rückfallebene zu den Webhooks; nur wenn eingeschaltet
        const { mocoEnabled } = await import("@/modules/moco/client");
        if (mocoEnabled()) {
          await runJob("moco-sync", async () => {
            const { runMocoSync } = await import("@/modules/moco/sync");
            return (await runMocoSync()) as unknown as Record<string, number>;
          });
        }
      }
      await dispatchPendingEmails(cfg);
      if (hour >= cfg.MAIL_DIGEST_HOUR && lastDigestDate !== date) {
        lastDigestDate = date;
        await dispatchDigests(cfg);
      }
    } catch (e) {
      console.error("Benachrichtigungstakt", (e as Error).message);
    } finally {
      busy = false;
    }
  };
  setTimeout(tick, 15_000);
  setInterval(tick, 60_000).unref?.();
}
