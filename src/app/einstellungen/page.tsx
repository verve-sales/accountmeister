import Link from "next/link";
import { redirect } from "next/navigation";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { getProviderStatus } from "@/modules/suggestions/service";
import { getMyConnection } from "@/modules/integrations/service";
import { getCurrentActor } from "@/modules/identity/session";
import { getConfig } from "@/lib/config";
import { fmtDateTime, integrationStatusLabel } from "@/lib/labels";
import { connectMailboxAction, createProfileReferenceAction, revokeMailboxAction } from "../actions";
import { listProfileReferences } from "@/modules/opportunities/service";
import { hasRole } from "@/modules/identity/actor";

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const ai = getProviderStatus();
  const cfg = getConfig();
  const conn = await getMyConnection(actor);
  const profileRefs = await listProfileReferences(actor);
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
      {(hasRole(actor, "BD") || hasRole(actor, "PRINCIPAL") || hasRole(actor, "CEO")) && (
        <section className="card">
          <h2 className="font-semibold mb-2">Freigegebene Profilreferenzen ({profileRefs.length})</h2>
          <p className="muted text-sm mb-2">Nur Verweise auf freigegebene Profile (Bezeichnung, Ablageort, Verfügbarkeit) – kein Profilinhalt, kein Kandidatenmanagement. Sichtbar für BD, Principal und CEO.</p>
          {profileRefs.length === 0 ? <p className="muted text-sm">Noch keine Profilreferenz.</p> : (
            <table className="list"><thead><tr><th>Bezeichnung</th><th>Ablage/Referenz</th><th>Verfügbarkeit</th><th>Freigegeben</th></tr></thead>
              <tbody>{profileRefs.map((r) => <tr key={r.id}><td>{r.label}</td><td className="text-sm">{r.sourceRef ?? "–"}</td><td className="text-sm">{r.availabilityNote ?? "–"}</td><td className="text-sm">{r.approvedAt ? fmtDateTime(r.approvedAt) : "–"}</td></tr>)}</tbody>
            </table>
          )}
          <details className="mt-3">
            <summary>Profilreferenz anlegen</summary>
            <form action={createProfileReferenceAction} className="mt-2 grid sm:grid-cols-3 gap-3">
              <div><label className="label" htmlFor="prLabel">Bezeichnung</label><input id="prLabel" name="label" className="input" required minLength={3} placeholder="z. B. Profil Senior Testkoordination (freigegeben 09/2026)" /></div>
              <div><label className="label" htmlFor="prRef">Ablageort / Referenz</label><input id="prRef" name="sourceRef" className="input" /></div>
              <div><label className="label" htmlFor="prAvail">Verfügbarkeit</label><input id="prAvail" name="availabilityNote" className="input" /></div>
              <div className="sm:col-span-3"><button className="btn" type="submit">Anlegen</button></div>
            </form>
          </details>
        </section>
      )}
      <section className="card">
        <h2 className="font-semibold mb-2">Administration und Aufbewahrung</h2>
        <p className="text-sm">Rollen, Zugänge, Protokoll und Bestandszahlen pflegt die Betriebsverwaltung unter <Link href="/verwaltung">Verwaltung</Link> (nur Rolle ADMIN, ohne Inhaltszugriff). Sperren und Löschen einzelner Quellen erfolgt auf der jeweiligen Quellenseite. Aufbewahrungsfristen und Erinnerungen folgen mit dem Löschkonzept bzw. der Unternehmensanmeldung (siehe <code>docs/pilotfreigabe.md</code>).</p>
      </section>
    </div>
  );
}
