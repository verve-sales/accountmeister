/** Startet beim Hochfahren des Servers den Benachrichtigungstakt (nur Node-Laufzeit, nicht in Tests). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV === "test" || process.env.NOTIFICATION_WORKER === "off") return;
  const { startNotificationWorker } = await import("./modules/notifications/worker");
  startNotificationWorker();
}
