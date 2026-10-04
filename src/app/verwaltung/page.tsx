import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { hasRole } from "@/modules/identity/actor";
import { dataInventory, listAuditEvents, listUsersWithRoles } from "@/modules/governance/service";
import { db, schema } from "@/db/client";
import { desc, eq } from "drizzle-orm";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { fmtDateTime, roleLabel } from "@/lib/labels";
import { getConfig } from "@/lib/config";
import { SESSION_IDLE_SECONDS, SESSION_MAX_AGE_SECONDS } from "@/modules/identity/session";
import { LIMITS } from "@/lib/ratelimit";
import { assignRoleAction, createUserAccessAction, revokeRoleAction, setUserStatusAction } from "../actions";
import { RoleAssignFields } from "@/components/RoleAssignFields";

export default async function VerwaltungPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!hasRole(actor, "ADMIN")) notFound();
  let users, audit, inventory;
  try {
    [users, audit, inventory] = await Promise.all([listUsersWithRoles(actor), listAuditEvents(actor, 150), dataInventory(actor)]);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const accounts = await db.query.accounts.findMany({ where: eq(schema.accounts.workspaceId, actor.workspaceId), orderBy: (a, { asc }) => [asc(a.name)] });
  const jobRuns = await db.query.jobRuns.findMany({ orderBy: desc(schema.jobRuns.startedAt), limit: 12 });
  const lastOk = new Map<string, Date>();
  for (const r of jobRuns) if (r.ok && r.finishedAt && !lastOk.has(r.name)) lastOk.set(r.name, r.finishedAt);
  const cfg = getConfig();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Verwaltung (Betriebsverwaltung)</h1>
      <p className="muted text-sm">Rollen, Zugänge, Protokoll und Bestandszahlen. Kein Zugriff auf Setup-Inhalte, Quellen, Notizen oder Vorschläge (Briefing 16.2). KI-Anbieter und Modelle je Aufgabe: <Link href="/verwaltung/ki">Verwaltung → KI</Link>. Standardrollenkatalog für Chancen: <Link href="/verwaltung/rollen">Verwaltung → Rollen</Link>. Teams, Warteschlangen und Leistungskatalog: <Link href="/verwaltung/teams">Verwaltung → Teams</Link>. Was laut Löschkonzept fällig ist: <Link href="/verwaltung/fristen">Verwaltung → Fristenprüfung</Link>.</p>
      <Feedback params={sp} />

      <section className="card">
        <h2 className="font-semibold mb-2">Hintergrundläufe (Takt im App-Prozess)</h2>
        <p className="muted text-sm mb-2">Stündlich ab 6 Uhr: Überfällig-Hinweise und Einsatzregeln (Catch-ups, Check-in-Hinweise, Verlängerungen); minütlich Sofort-Mails; täglich Digest. Letzter erfolgreicher Lauf je Regel: {[...lastOk].map(([n, d]) => `${n} ${fmtDateTime(d)}`).join(" · ") || "noch keiner (startet 15 s nach dem Hochfahren, erster Lauf zur vollen Stunde)"}.</p>
        {jobRuns.length > 0 && (
          <table className="list text-sm">
            <thead><tr><th>Lauf</th><th>Start</th><th>Ergebnis</th></tr></thead>
            <tbody>
              {jobRuns.map((r) => (
                <tr key={r.id}><td>{r.name}</td><td>{fmtDateTime(r.startedAt)}</td><td>{r.ok === null ? "läuft" : r.ok ? JSON.stringify(r.counts) : <span style={{ color: "#c0392b" }}>Fehler: {r.error}</span>}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Konfiguration und Schutzmaßnahmen</h2>
        <table className="list text-sm">
          <tbody>
            <tr><td>Umgebung</td><td>{cfg.NODE_ENV} · Anmeldung: {cfg.AUTH_MODE} · KI-Anbieter: {cfg.AI_PROVIDER}</td></tr>
            <tr><td>Sitzung</td><td>Höchstdauer {Math.round(SESSION_MAX_AGE_SECONDS / 3600)} h, Inaktivitätsgrenze {Math.round(SESSION_IDLE_SECONDS / 3600)} h (SESSION_MAX_AGE_SECONDS, SESSION_IDLE_SECONDS)</td></tr>
            <tr><td>Nutzungsgrenzen</td><td>Anmeldeversuche {LIMITS.login.limit} / 15 min je Herkunft · schreibende Aktionen {LIMITS.write.limit} / min je Person · KI-Aufträge {cfg.AI_DAILY_JOB_LIMIT} / Tag</td></tr>
            <tr><td>Startschutz</td><td>Produktion verweigert AUTH_MODE=development, AI_PROVIDER=test und den Beispiel-SESSION_SECRET (S09).</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Bestand je Datenklasse (Zählungen)</h2>
        <table className="list text-sm">
          <thead><tr><th>Schutzbereich (16.1)</th><th>Objekte</th></tr></thead>
          <tbody>
            <tr><td>Kundenkontakte und externe Personen</td><td>{inventory.kundenkontakte.persons} Personen · {inventory.kundenkontakte.relationships} Beziehungen · {inventory.kundenkontakte.decisionParticipations} Buyingcenter-Rollen</td></tr>
            <tr><td>Quellen</td><td>{inventory.quellen.sources} Quellen ({inventory.quellen.locked} gesperrt, {inventory.quellen.erased} Inhalt entfernt) · {inventory.quellen.sourceVersions} Versionen</td></tr>
            <tr><td>Verve-Beschäftigte</td><td>{inventory.beschaeftigte.users} Zugänge · {inventory.beschaeftigte.goals} Ziele · {inventory.beschaeftigte.confidentialNotes} vertrauliche Notizen · {inventory.beschaeftigte.supportRequests} Unterstützungsaufträge</td></tr>
            <tr><td>Fallbearbeitung</td><td>{inventory.fall.setups} Setups · {inventory.fall.signals} Beobachtungen · {inventory.fall.opportunities} Chancen · {inventory.fall.offers} Angebote · {inventory.fall.orders} Aufträge</td></tr>
            <tr><td>KI</td><td>{inventory.ki.aiJobs} Aufträge (nur Hash/Länge, kein Text) · {inventory.ki.suggestions} Vorschläge</td></tr>
            <tr><td>Protokoll</td><td>{inventory.audit} Ereignisse</td></tr>
          </tbody>
        </table>
        <p className="muted text-xs mt-1">Aufbewahrungsfristen je Datenklasse: `docs/pilotfreigabe-vorschlag.md` Abschnitt 6. Was davon automatisch ermittelt werden kann, zeigt <Link href="/verwaltung/fristen">Verwaltung → Fristenprüfung</Link>.</p>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Zugänge und Rollen ({users.filter((u) => u.status === "ACTIVE").length} aktiv{users.some((u) => u.status !== "ACTIVE") ? `, ${users.filter((u) => u.status !== "ACTIVE").length} deaktiviert – unten` : ""})</h2>
        <table className="list text-sm">
          <thead><tr><th>Person</th><th>Status</th><th>Rollen</th><th></th></tr></thead>
          <tbody>
            {[...users.filter((u) => u.status === "ACTIVE"), ...users.filter((u) => u.status !== "ACTIVE")].map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}<div className="muted">{u.email}</div></td>
                <td><Status label={u.status === "ACTIVE" ? "Aktiv" : "Deaktiviert"} />{u.status !== "ACTIVE" && <div className="muted text-xs">keine Rollen, keine Anmeldung</div>}</td>
                <td>
                  <ul className="space-y-1">
                    {u.roles.map((r) => (
                      <li key={r.id} className="flex gap-2 items-center">
                        <span>{roleLabel[r.role] ?? r.role}{r.accountName && <span className="muted"> · {r.accountName}</span>}</span>
                        <form action={revokeRoleAction}><input type="hidden" name="roleAssignmentId" value={r.id} /><button className="btn btn-secondary btn-small" type="submit" aria-label={`Rolle ${r.role} entziehen`}>entziehen</button></form>
                      </li>
                    ))}
                  </ul>
                </td>
                <td>
                  {u.id !== actor.userId && (
                    <form action={setUserStatusAction}><input type="hidden" name="userId" value={u.id} /><input type="hidden" name="status" value={u.status === "ACTIVE" ? "INACTIVE" : "ACTIVE"} /><button className="btn btn-secondary btn-small" type="submit">{u.status === "ACTIVE" ? "Deaktivieren" : "Aktivieren"}</button></form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <details className="mt-3">
          <summary>Zugang anlegen</summary>
          <form action={createUserAccessAction} className="mt-2 grid sm:grid-cols-3 gap-3">
            <div><label className="label" htmlFor="uEmail">E-Mail (Microsoft-365-Konto)</label><input id="uEmail" name="email" type="email" className="input" required /></div>
            <div><label className="label" htmlFor="uName">Name</label><input id="uName" name="displayName" className="input" required minLength={2} /></div>
            <div className="self-end"><button className="btn" type="submit">Zugang anlegen</button></div>
            <p className="muted text-xs sm:col-span-3">Ohne Rolle sieht die Person nach der Anmeldung keine Inhalte. Rollen unten zuweisen.</p>
          </form>
        </details>
        <details className="mt-3">
          <summary>Rolle zuweisen</summary>
          <form action={assignRoleAction} className="mt-2 grid sm:grid-cols-4 gap-3">
            <RoleAssignFields users={users} roleLabelEntries={Object.entries(roleLabel)} accounts={accounts} />
            <div className="self-end"><button className="btn" type="submit">Zuweisen</button></div>
          </form>
        </details>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Protokoll (letzte {audit.length} Ereignisse)</h2>
        <p className="muted text-sm mb-2">Wer hat wann was an welchem Objekt getan. Inhalte werden nicht protokolliert; Änderungsdetails erscheinen nur als Feldnamen.</p>
        <table className="list text-sm">
          <thead><tr><th>Zeitpunkt</th><th>Akteur</th><th>Aktion</th><th>Objekt</th><th>Felder</th></tr></thead>
          <tbody>{audit.map((a) => <tr key={a.id}><td>{fmtDateTime(a.at)}</td><td>{a.actor}</td><td>{a.action}</td><td className="muted">{a.objectType} {a.objectId.slice(0, 8)}…</td><td className="muted">{a.changeKeys.join(", ") || "–"}</td></tr>)}</tbody>
        </table>
      </section>
    </div>
  );
}
