import { getConfig } from "@/lib/config";
import { generateOverdueNotifications } from "@/modules/work/service";
import { dispatchDigests, dispatchPendingEmails } from "./mailer";

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
        await generateOverdueNotifications();
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
