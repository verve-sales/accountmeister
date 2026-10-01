import Link from "next/link";
import { redirect } from "next/navigation";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { getProviderStatus } from "@/modules/suggestions/service";
import { getMyConnection } from "@/modules/integrations/service";
import { getCurrentActor } from "@/modules/identity/session";
import { getConfig } from "@/lib/config";
import { fmtDate, fmtDateTime, integrationStatusLabel } from "@/lib/labels";
import { listProfileReferences } from "@/modules/opportunities/service";
import { hasRole } from "@/modules/identity/actor";
import { getMyPrefs, notificationKindLabel, notificationKinds } from "@/modules/notifications/service";
import { listMyAbsences } from "@/modules/work/teams";
import { workTargets } from "@/modules/work/service";
import { addAbsenceAction, connectMailboxAction, createProfileReferenceAction, removeAbsenceAction, revokeMailboxAction, saveNotificationPrefsAction } from "../actions";

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const ai = getProviderStatus();
  const cfg = getConfig();
  const conn = await getMyConnection(actor);
  const profileRefs = await listProfileReferences(actor);
  const [prefs, absences, targets] = await Promise.all([getMyPrefs(actor), listMyAbsences(actor), workTargets(actor)]);
  const userName = new Map(targets.users.map((u) => [u.id, u.name]));
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Einstellungen</h1>
      <Feedback params={params} />
      <section className="card" id="benachrichtigungen">
        <h2 className="font-semibold mb-1">Benachrichtigungen</h2>
        <p className="muted text-sm mb-2">
          Alle Hinweise erscheinen an der Glocke oben. Per E-Mail kommt sofort, was du hier anhakst; der Rest auf Wunsch einmal täglich im Überblick (gegen {cfg.MAIL_DIGEST_HOUR} Uhr).
          {cfg.MAIL_TRANSPORT === "off" ? " Der E-Mail-Versand ist derzeit noch ausgeschaltet – deine Auswahl gilt, sobald er eingeschaltet wird." : ""}
        </p>
        <form action={saveNotificationPrefsAction} className="space-y-2">
          <input type="hidden" name="back" value="/einstellungen#benachrichtigungen" />
          <fieldset className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <legend className="label">Sofort per E-Mail</legend>
            {notificationKinds.map((k) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" name={`email_${k}`} defaultChecked={prefs.email[k]} /> {notificationKindLabel[k]}
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="digest" defaultChecked={prefs.digest} /> Alles andere im täglichen Überblick per E-Mail
          </label>
          <button className="btn btn-small" type="submit">Speichern</button>
        </form>
      </section>

      <section className="card" id="abwesenheit">
        <h2 className="font-semibold mb-1">Abwesenheit und Vertretung</h2>
        <p className="muted text-sm mb-2">In diesem Zeitraum gehen neue Anfragen an dich direkt an deine Vertretung; sie erhält auch deine Benachrichtigungen. Bestehende Vorgänge bleiben bei dir.</p>
        {absences.length > 0 && (
          <ul className="text-sm space-y-1 mb-2">
            {absences.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-2 items-center">
                {fmtDate(a.fromDate)} – {fmtDate(a.toDate)} · Vertretung: {a.deputyUserId ? userName.get(a.deputyUserId) ?? "?" : "keine"}{a.note ? ` · ${a.note}` : ""}
                <form action={removeAbsenceAction}>
                  <input type="hidden" name="absenceId" value={a.id} />
                  <input type="hidden" name="back" value="/einstellungen#abwesenheit" />
                  <button className="btn btn-secondary btn-small" type="submit">Entfernen</button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form action={addAbsenceAction} className="flex flex-wrap gap-2 items-end">
          <input type="hidden" name="back" value="/einstellungen#abwesenheit" />
          <div><label className="label" htmlFor="absFrom">Von</label><input id="absFrom" type="date" name="fromDate" className="input" required /></div>
          <div><label className="label" htmlFor="absTo">Bis</label><input id="absTo" type="date" name="toDate" className="input" required /></div>
          <div>
            <label className="label" htmlFor="absDeputy">Vertretung</label>
            <select id="absDeputy" name="deputyUserId" className="input" defaultValue="">
              <option value="">keine</option>
              {targets.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div><label className="label" htmlFor="absNote">Notiz (optional)</label><input id="absNote" name="note" className="input" maxLength={300} /></div>
          <button className="btn btn-small" type="submit">Eintragen</button>
        </form>
      </section>
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
              <a className="btn btn-secondary" href="/api/integrations/microsoft/authorize">Echtes Postfach verbinden</a>
              <p className="muted text-sm">Führt zur Anmeldung bei Microsoft. Setzt voraus, dass die App-Registrierung die Berechtigungen aus <code>docs/installation-ionos.md</code> Schritt 4b hat – sonst wird ehrlich abgewiesen.</p>
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
            <tr><td>Mail-/Kalenderanbieter</td><td>Microsoft 365 / Outlook über Microsoft Graph (Entscheidung E-018). Echter Abruf möglich, sobald die Berechtigungen in Entra ID gesetzt sind (<code>docs/installation-ionos.md</code> Schritt 4b) – jede Person verbindet ihr eigenes Postfach selbst, oben.</td></tr>
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
