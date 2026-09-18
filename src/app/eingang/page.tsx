import Link from "next/link";
import { redirect } from "next/navigation";
import { schema } from "@/db/client";
import { getCurrentActor } from "@/modules/identity/session";
import { listMySetups, listSetupsWithOpenAssignment } from "@/modules/setups/service";
import { getMyConnection, listSelectable } from "@/modules/integrations/service";
import { listMyImports } from "@/modules/imports/service";
import { getProviderStatus } from "@/modules/suggestions/service";
import { Feedback } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { accessClassLabel, fmtDate, fmtDateTime, importKindLabel, importStatusLabel } from "@/lib/labels";
import { confirmImportAction, decideMergeAction, importMailboxItemAction, importProtocolAction } from "../actions";

export default async function EingangPage({ searchParams }: { searchParams: Promise<{ fehler?: string; ok?: string; art?: string; q?: string }> }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const [open, mySetups, imports, conn] = await Promise.all([listSetupsWithOpenAssignment(actor), listMySetups(actor), listMyImports(actor), getMyConnection(actor)]);
  const ai = getProviderStatus();
  const kind = params.art === "TERMIN" ? "TERMIN" : "MAIL";
  let selectable: Awaited<ReturnType<typeof listSelectable>>["items"] = [];
  let selectableError: string | null = null;
  if (conn.state.connected) {
    try {
      selectable = (await listSelectable(actor, kind, params.q)).items;
    } catch (e) {
      selectableError = e instanceof Error ? e.message : "Abruf fehlgeschlagen";
    }
  }
  const editableSetups = mySetups;
  const pending = imports.filter((j) => j.status !== "BESTAETIGT" && j.status !== "VERWORFEN");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Eingang</h1>
      <Feedback params={params} />

      <section className="card">
        <h2 className="font-semibold mb-2">Setups mit offener BD-Zuordnung ({open.length})</h2>
        {open.length === 0 ? <p className="muted text-sm">Keine offenen Zuordnungen in Ihrem Berechtigungsbereich.</p> : (
          <table className="list">
            <thead><tr><th>Setup</th><th>Kunde</th><th>Angelegt</th></tr></thead>
            <tbody>{open.map(({ setup, account }) => <tr key={setup.id}><td><Link href={`/setups/${setup.id}`}>{setup.name}</Link></td><td><Link href={`/kunden/${account.id}`}>{account.name}</Link></td><td>{fmtDate(setup.createdAt)}</td></tr>)}</tbody>
          </table>
        )}
      </section>

      {/* Zu prüfende Importe */}
      <section className="card">
        <h2 className="font-semibold mb-2">Zu prüfende Importe ({pending.length})</h2>
        {pending.length === 0 ? <p className="muted text-sm">Keine offenen Importe.</p> : (
          <ul className="space-y-3">
            {pending.map((j) => (
              <li key={j.id} className="border rounded-md p-3" style={{ borderColor: "var(--border)" }}>
                <div className="flex flex-wrap gap-2 items-baseline">
                  <strong>{j.title}</strong>
                  <Status label={importKindLabel[j.kind] ?? j.kind} />
                  <Status label={importStatusLabel[j.status] ?? j.status} />
                  <span className="muted text-sm">→ {j.setupId ? <Link href={`/setups/${j.setupId}`}>{j.setupName}</Link> : "kein Setup"} · Empfängerkreis {accessClassLabel[j.accessClass]} · {j.scopeSummary}</span>
                </div>
                {j.warnings.length > 0 && <ul className="text-sm mt-1 list-disc ml-5" style={{ color: "var(--warn)" }}>{j.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
                {j.error && <p className="text-sm error mt-1">{j.error}</p>}
                <p className="text-sm mt-1">{j.sourceId && <Link href={`/quellen/${j.sourceId}`}>Quelle ansehen</Link>}{j.setupId && <> · <Link href={`/setups/${j.setupId}`}>Vorschläge im Setup prüfen</Link></>}</p>
                {j.mergeItems.filter((m) => m.status === "OFFEN").length > 0 && (
                  <div className="mt-2 text-sm">
                    <h3 className="font-medium">Unklare Personenzuordnung – bitte entscheiden (gleicher Name ist kein Identitätsbeweis)</h3>
                    <ul className="space-y-2 mt-1">
                      {j.mergeItems.filter((m) => m.status === "OFFEN").map((m) => (
                        <li key={m.id}>
                          <form action={decideMergeAction} className="flex flex-wrap gap-1 items-end">
                            <input type="hidden" name="itemId" value={m.id} />
                            <span className="grow min-w-40">{m.mentionedName}{m.mentionedEmail && <span className="muted"> ({m.mentionedEmail})</span>} · {m.candidates.length} Kandidat(en)</span>
                            {m.candidates.length > 0 && (
                              <select name="personId" className="select" style={{ width: "16rem" }} defaultValue={m.candidates.length === 1 ? m.candidates[0]!.id : ""} aria-label="Person">
                                <option value="">– Person wählen –</option>
                                {m.candidates.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
                              </select>
                            )}
                            {m.candidates.length > 0 && <button className="btn btn-small" name="decision" value="ZUSAMMENGEFUEHRT">Ist diese Person</button>}
                            <button className="btn btn-secondary btn-small" name="decision" value="NEUE_PERSON">Neue Person anlegen</button>
                            <button className="btn btn-secondary btn-small" name="decision" value="IGNORIERT">Ignorieren</button>
                          </form>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <form action={confirmImportAction} className="mt-2">
                  <input type="hidden" name="importJobId" value={j.id} />
                  <input type="hidden" name="version" value={j.version} />
                  <button className="btn btn-small" type="submit">Import bestätigen</button>
                  <span className="muted text-sm ml-2">Bestätigt Quellenbezug und Prüfung; offene Vorschläge bleiben zur Entscheidung im Setup.</span>
                </form>
              </li>
            ))}
          </ul>
        )}
        {imports.length > pending.length && <p className="muted text-sm mt-2">{imports.length - pending.length} bestätigte Importe im Protokoll.</p>}
      </section>

      {/* Protokoll importieren */}
      <section className="card">
        <h2 className="font-semibold mb-2">Gesprächsprotokoll importieren</h2>
        {editableSetups.length === 0 ? <p className="muted text-sm">Sie bearbeiten kein Setup; Import ist nicht möglich.</p> : (
          <form action={importProtocolAction} className="grid sm:grid-cols-2 gap-3" encType="multipart/form-data">
            <div><label className="label" htmlFor="impTitle">Titel</label><input id="impTitle" name="title" className="input" required minLength={3} placeholder="z. B. Protokoll Kundentermin 18.09." /></div>
            <div>
              <label className="label" htmlFor="impSetup">Zielsetup</label>
              <select id="impSetup" name="setupId" className="select" required defaultValue=""><option value="" disabled>Bitte wählen …</option>{editableSetups.map((s) => <option key={s.id} value={s.id}>{s.accountName} – {s.name}</option>)}</select>
            </div>
            <div className="sm:col-span-2"><label className="label" htmlFor="impText">Protokolltext (einfügen) – oder Datei wählen</label><textarea id="impText" name="text" className="textarea" style={{ minHeight: "8rem" }} placeholder="Nur Text. HTML wird entfernt, Links werden nicht abgerufen." /></div>
            <div><label className="label" htmlFor="impFile">Datei (.txt, .md; max. 2 MB)</label><input id="impFile" name="file" type="file" accept=".txt,.md,text/plain,text/markdown" className="input" /></div>
            <div>
              <label className="label" htmlFor="impAccess">Interner Empfängerkreis der Quelle</label>
              <select id="impAccess" name="accessClass" className="select" defaultValue="SETUP">{schema.accessClassEnum.enumValues.map((v) => <option key={v} value={v}>{accessClassLabel[v]}</option>)}</select>
            </div>
            <div><label className="label" htmlFor="impTime">Zeitpunkt des Gesprächs</label><input id="impTime" name="sourceTime" type="datetime-local" className="input" /></div>
            <div className="flex items-end"><label className="text-sm flex items-center gap-2"><input type="checkbox" name="structure" value="true" defaultChecked={ai.enabled} disabled={!ai.enabled} /> Nach Übernahme strukturieren (KI: {ai.enabled ? ai.model : "deaktiviert"})</label></div>
            <div className="sm:col-span-2"><button className="btn" type="submit">Quelle übernehmen</button></div>
          </form>
        )}
        <p className="muted text-sm mt-2">Importprozess: Quelle wählen → Zielsetup → Umfang und Empfängerkreis → übernehmen → auswerten → Konflikte/Zuordnungen prüfen → bestätigen. Jeder Schritt wird protokolliert.</p>
      </section>

      {/* Postfach */}
      <section className="card">
        <h2 className="font-semibold mb-2">Aus dem eigenen Postfach importieren (Outlook)</h2>
        {!conn.state.connected ? (
          <p className="muted text-sm">Kein Postfach verbunden. <Link href="/einstellungen">Unter Einstellungen verbinden</Link>. Es wird nie ein ganzes Postfach eingelesen – Sie wählen einzelne Mails oder Termine.</p>
        ) : (
          <>
            <p className="text-sm muted mb-2">{conn.state.accountLabel} · Berechtigungen: {conn.state.grantedScopes.join(", ")}{conn.state.fixtureMode && " · Fixture-Modus: fiktive Testquellen"}</p>
            <form className="flex flex-wrap gap-2 items-end mb-3" method="get">
              <div><label className="label" htmlFor="art">Art</label><select id="art" name="art" className="select" defaultValue={kind}><option value="MAIL">E-Mails</option><option value="TERMIN">Termine</option></select></div>
              <div><label className="label" htmlFor="q">Suche (Betreff, Absender)</label><input id="q" name="q" className="input" defaultValue={params.q ?? ""} /></div>
              <button className="btn btn-secondary btn-small" type="submit">Anzeigen</button>
            </form>
            {selectableError ? <p className="error">{selectableError}</p> : selectable.length === 0 ? <p className="muted text-sm">Keine passenden Objekte.</p> : (
              <table className="list">
                <thead><tr><th>Betreff</th><th>Von</th><th>Zeitpunkt</th><th>Vorschau</th><th>Import</th></tr></thead>
                <tbody>
                  {selectable.map((it) => {
                    const done = imports.find((j) => j.externalKey.endsWith(`:${it.kind}:${it.externalId}`));
                    return (
                      <tr key={it.externalId}>
                        <td>{it.subject}{it.hasAttachments && <div className="muted text-sm">Anhänge werden nicht übernommen</div>}</td>
                        <td className="text-sm">{it.from?.name ?? "–"}</td>
                        <td className="text-sm">{fmtDateTime(it.at)}</td>
                        <td className="text-sm muted">{it.preview}</td>
                        <td>
                          {done ? <span className="text-sm">bereits importiert {done.sourceId && <Link href={`/quellen/${done.sourceId}`}>(Quelle)</Link>}</span> : (
                            <form action={importMailboxItemAction} className="flex flex-wrap gap-1 items-end">
                              <input type="hidden" name="kind" value={it.kind} />
                              <input type="hidden" name="externalId" value={it.externalId} />
                              <select name="setupId" className="select" style={{ width: "13rem" }} required defaultValue="" aria-label="Zielsetup"><option value="" disabled>Zielsetup …</option>{editableSetups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                              <select name="accessClass" className="select" style={{ width: "10rem" }} defaultValue="PERSOENLICH" aria-label="Empfängerkreis">{schema.accessClassEnum.enumValues.map((v) => <option key={v} value={v}>{accessClassLabel[v]}</option>)}</select>
                              <label className="text-sm flex items-center gap-1"><input type="checkbox" name="structure" value="true" defaultChecked={ai.enabled} disabled={!ai.enabled} /> auswerten</label>
                              <button className="btn btn-small" type="submit">Übernehmen</button>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
    </div>
  );
}
