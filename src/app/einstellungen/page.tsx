import { NotYet } from "@/components/NotYet";
import { getProviderStatus } from "@/modules/suggestions/service";
import { getConfig } from "@/lib/config";

export default function Page() {
  const ai = getProviderStatus();
  const cfg = getConfig();
  return (
    <div className="space-y-6">
      <section className="card">
        <h1 className="text-xl font-semibold mb-2">Einstellungen – Status der Anbindungen</h1>
        <table className="list">
          <tbody>
            <tr><td>KI-Anbieter</td><td>{ai.id} · {ai.model} · {ai.enabled ? "aktiv" : "deaktiviert"}<div className="muted text-sm">{ai.description}</div></td></tr>
            <tr><td>Prompt-/Schemaversion</td><td>{ai.promptVersion}</td></tr>
            <tr><td>Nutzungsgrenze</td><td>{ai.dailyLimit} KI-Aufträge je Arbeitsraum und Tag</td></tr>
            <tr><td>Anmeldung</td><td>{cfg.AUTH_MODE === "development" ? "Entwicklungsanmeldung (nur lokal)" : "Unternehmensanmeldung (OIDC)"}</td></tr>
            <tr><td>Mail-/Kalenderanbieter</td><td>Entscheidung: Microsoft 365 / Outlook (Microsoft Graph). Adapter noch nicht angebunden – kein Import aktiv.</td></tr>
          </tbody>
        </table>
        <p className="muted text-sm mt-2">Änderungen erfolgen über die Serverkonfiguration (.env), nicht über diese Seite. Produktivadapter sind bis zur Anbieter- und Datenschutzfreigabe gesperrt.</p>
      </section>
      <NotYet title="Eigene Integrationen und Benachrichtigungen" etappe="Etappe 3 (Teil B)" inhalt="Persönliche Outlook-Verbindung (nur lesend, minimale Berechtigungen), Auswahl einzelner Mails/Termine für den Import, Benachrichtigungseinstellungen." />
    </div>
  );
}
