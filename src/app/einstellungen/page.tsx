import Link from "next/link";
import { redirect } from "next/navigation";
import { NotYet } from "@/components/NotYet";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { getProviderStatus } from "@/modules/suggestions/service";
import { getMyConnection } from "@/modules/integrations/service";
import { getCurrentActor } from "@/modules/identity/session";
import { getConfig } from "@/lib/config";
import { fmtDateTime, integrationStatusLabel } from "@/lib/labels";
import { connectMailboxAction, revokeMailboxAction } from "../actions";

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const ai = getProviderStatus();
  const cfg = getConfig();
  const conn = await getMyConnection(actor);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Einstellungen</h1>
      <Feedback params={params} />
      <section className="card">
        <h2 className="font-semibold mb-2">Mein Postfach (Microsoft 365 / Outlook)</h2>
        <p className="muted text-sm mb-2">Lesender Zugriff mit minimalen Berechtigungen. Es wird nie ein ganzes Postfach eingelesen: Sie wählen im <Link href="/eingang">Eingang</Link> einzelne Mails oder Termine aus. Kein Senden, keine Terminbuchung.</p>
        <table className="list">
          <tbody>
            <tr><td>Status</td><td>{conn.connection ? <Status label={integrationStatusLabel[conn.connection.status] ?? conn.connection.status} /> : <Status label="Nicht verbunden" />}{conn.state.accountLabel && <span className="muted text-sm ml-2">{conn.state.accountLabel}</span>}</td></tr>
            <tr><td>Benötigte Berechtigungen</td><td className="text-sm">{conn.requestedScopes.join(", ")}</td></tr>
            <tr><td>Gewährte Berechtigungen</td><td className="text-sm">{conn.state.grantedScopes.length ? conn.state.grantedScopes.join(", ") : "–"}</td></tr>
            <tr><td>Letzter erfolgreicher Abruf</td><td className="text-sm">{conn.connection?.lastSuccessfulFetchAt ? fmtDateTime(conn.connection.lastSuccessfulFetchAt) : "–"}</td></tr>
            {conn.connection?.lastError && <tr><td>Letzter Fehler</td><td className="text-sm error">{conn.connection.lastError}</td></tr>}
          </tbody>
        </table>
        <div className="mt-3 flex flex-wrap gap-3 items-end">
          {!conn.state.connected ? (
            <>
              <form action={connectMailboxAction}><input type="hidden" name="mode" value="fixture" /><button className="btn" type="submit">Verbinden (Fixture-Modus)</button></form>
              <form action={connectMailboxAction}><input type="hidden" name="mode" value="echt" /><button className="btn btn-secondary" type="submit">Echtes Postfach verbinden</button></form>
              <p className="muted text-sm">Der echte Verbindungsaufbau ist bis zur App-Registrierung im Verve-Tenant und zur Datenschutzfreigabe gesperrt und wird ehrlich abgewiesen.</p>
            </>
          ) : (
            <form action={revokeMailboxAction}><button className="btn btn-secondary" type="submit">Verbindung widerrufen</button></form>
          )}
        </div>
      </section>
      <section className="card">
        <h2 className="font-semibold mb-2">Status der Anbindungen</h2>
        <table className="list">
          <tbody>
            <tr><td>KI-Anbieter</td><td>{ai.id} · {ai.model} · {ai.enabled ? "aktiv" : "deaktiviert"}<div className="muted text-sm">{ai.description}</div></td></tr>
            <tr><td>Prompt-/Schemaversion</td><td>{ai.promptVersion}</td></tr>
            <tr><td>Nutzungsgrenze</td><td>{ai.dailyLimit} KI-Aufträge je Arbeitsraum und Tag</td></tr>
            <tr><td>Anmeldung</td><td>{cfg.AUTH_MODE === "development" ? "Entwicklungsanmeldung (nur lokal)" : "Unternehmensanmeldung (OIDC)"}</td></tr>
            <tr><td>Mail-/Kalenderanbieter</td><td>Microsoft 365 / Outlook über Microsoft Graph (Entscheidung E-018). Adapter vorhanden; echter Abruf nach App-Registrierung und Datenschutzfreigabe.</td></tr>
          </tbody>
        </table>
        <p className="muted text-sm mt-2">Änderungen erfolgen über die Serverkonfiguration (.env), nicht über diese Seite.</p>
      </section>
      <NotYet title="Benachrichtigungen und Administration" etappe="Etappe 5" inhalt="Erinnerungseinstellungen, Review-Rhythmen, berechtigte Administration von Rollen und Aufbewahrung." />
    </div>
  );
}
