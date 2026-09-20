import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { hasRole } from "@/modules/identity/actor";
import { getAiOverview } from "@/modules/ai/settings";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { fmtDateTime } from "@/lib/labels";
import { saveAiTaskSettingAction, testAiConnectionAction } from "../../actions";

/**
 * Verwaltung → KI: Anbieterstatus, verfügbare Modelle (aus dem Langdock-Arbeitsraum), Modellwahl je Aufgabe,
 * Verbrauch der letzten 30 Tage. Der API-Schlüssel wird hier nie angezeigt oder gesetzt (nur .env.production).
 */
export default async function KiVerwaltungPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!hasRole(actor, "ADMIN")) notFound();
  let o;
  try {
    o = await getAiOverview(actor);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const modelIds = o.models.map((m) => m.id);
  const jobTypeLabel: Record<string, string> = { STRUCTURE_NOTE: "Notiz strukturieren", ANALYZE_DOCUMENT: "Dokument analysieren" };

  return (
    <div className="space-y-6">
      <p className="text-sm"><Link href="/verwaltung">← Verwaltung</Link></p>
      <h1 className="text-2xl font-semibold">KI-Konfiguration</h1>
      <Feedback params={sp} />

      <section className="card">
        <h2 className="font-semibold mb-2">Anbieter</h2>
        <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <div><dt className="muted">Konfiguriert (AI_PROVIDER)</dt><dd><Status label={o.provider.configured} /> {o.provider.description}</dd></div>
          <div><dt className="muted">Status</dt><dd>{o.provider.enabled ? "aktiv – Inhalte werden zur Verarbeitung an den Anbieter gesendet" : "deaktiviert – keine externe Verarbeitung"}</dd></div>
          {o.provider.baseUrl && <div><dt className="muted">Schnittstelle</dt><dd>{o.provider.baseUrl}</dd></div>}
          {o.provider.configured === "langdock" && <div><dt className="muted">API-Schlüssel</dt><dd>{o.provider.keyPresent ? "hinterlegt (nur auf dem Server)" : "fehlt – LANGDOCK_API_KEY in .env.production setzen"}</dd></div>}
          <div><dt className="muted">Standardmodell</dt><dd>{o.provider.model}</dd></div>
          <div><dt className="muted">Nutzungsgrenze</dt><dd>{o.provider.dailyLimit} KI-Aufträge je Tag</dd></div>
        </dl>
        {o.provider.configured === "langdock" && (
          <form action={testAiConnectionAction} className="mt-3 flex flex-wrap items-center gap-3">
            <button className="btn btn-secondary" type="submit">Verbindung prüfen</button>
            <span className="muted text-sm">Ruft nur die Modellliste ab; es werden keine Inhalte gesendet.</span>
          </form>
        )}
        {o.provider.configured !== "langdock" && <p className="muted text-sm mt-3">Zum Aktivieren: in <code>.env.production</code> auf dem Server <code>AI_PROVIDER=langdock</code> und <code>LANGDOCK_API_KEY=…</code> setzen, dann <code>docker compose up -d</code>. Grundlage: Entscheidung E-037 (Langdock, EU-Hosting, AV-Vertrag).</p>}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Modelle je Aufgabe</h2>
        {o.modelsError && <p className="text-sm mb-2">Modellliste nicht abrufbar: {o.modelsError}. Persönliche Langdock-Schlüssel dürfen nur die Completion-Endpunkte nutzen; mit einem Workspace-Schlüssel erscheint die Liste. Modellnamen (wie in Langdock angezeigt, z. B. <code>gpt-4o-mini</code>, <code>claude-sonnet-4-5</code>) lassen sich von Hand eintragen.</p>}
        {o.models.length > 0 && <p className="muted text-sm mb-2">{o.models.length} Modelle im Langdock-Arbeitsraum verfügbar.</p>}
        <div className="space-y-4">
          {o.tasks.map((t) => (
            <form key={t.key} action={saveAiTaskSettingAction} className="border-t pt-3 grid sm:grid-cols-[2fr_2fr_1fr_1fr_auto_auto] gap-3 items-end">
              <input type="hidden" name="task" value={t.key} />
              <div className="sm:col-span-6"><strong>{t.label}</strong><div className="muted text-sm">{t.description}</div></div>
              <div>
                <label className="label" htmlFor={`model-${t.key}`}>Modell</label>
                {modelIds.length > 0 ? (
                  <select id={`model-${t.key}`} name="model" className="select" defaultValue={modelIds.includes(t.model ?? "") ? t.model : ""}>
                    {!modelIds.includes(t.model ?? "") && <option value={t.model}>{t.model} (nicht in Liste)</option>}
                    {o.models.map((m) => <option key={m.id} value={m.id}>{m.id}{m.ownedBy ? ` · ${m.ownedBy}` : ""}</option>)}
                  </select>
                ) : (
                  <input id={`model-${t.key}`} name="model" className="input" defaultValue={t.model} required />
                )}
              </div>
              <div className="muted text-sm">Quelle: {t.source === "konfiguriert" ? `konfiguriert${t.updatedAt ? ` (${fmtDateTime(t.updatedAt)})` : ""}` : "Standard aus Konfiguration"}</div>
              <div><label className="label" htmlFor={`temp-${t.key}`}>Temperatur</label><input id={`temp-${t.key}`} name="temperature" type="number" step="0.1" min={0} max={1} className="input" defaultValue={t.temperature ?? 0.2} /></div>
              <div><label className="label" htmlFor={`max-${t.key}`}>Max. Ausgabe (Tokens)</label><input id={`max-${t.key}`} name="maxOutputTokens" type="number" min={256} max={32000} step={1} className="input" defaultValue={t.maxOutputTokens ?? 4000} /></div>
              <label className="flex items-center gap-2 text-sm pb-2"><input type="checkbox" name="enabled" defaultChecked={t.enabled} /> aktiv</label>
              <button className="btn btn-small" type="submit">Speichern</button>
            </form>
          ))}
        </div>
        <p className="muted text-sm mt-3">Empfehlung: niedrige Temperatur (0–0,3) für Strukturierung und Analyse; die Ausgabe ist JSON und wird gegen das Schema geprüft. Änderungen werden protokolliert.</p>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Verbrauch der letzten 30 Tage</h2>
        {o.usage.length === 0 ? <p className="muted text-sm">Keine KI-Aufträge im Zeitraum.</p> : (
          <table className="list text-sm">
            <thead><tr><th>Aufgabe</th><th>Modell</th><th>Aufträge</th><th>davon erfolgreich</th><th>Tokens Eingabe</th><th>Tokens Ausgabe</th></tr></thead>
            <tbody>
              {o.usage.map((u, i) => <tr key={i}><td>{jobTypeLabel[u.type] ?? u.type}</td><td>{u.model}</td><td>{u.jobs}</td><td>{u.ok}</td><td>{u.tokensIn.toLocaleString("de-DE")}</td><td>{u.tokensOut.toLocaleString("de-DE")}</td></tr>)}
            </tbody>
          </table>
        )}
        <p className="muted text-sm mt-2">Token-Zahlen stammen vom Anbieter; die Kosten je Modell entnehmen Sie Ihrem Langdock-Vertrag. Auftragsprotokolle enthalten nie Rohtexte, nur Hash und Länge.</p>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Letzte Aufträge</h2>
        {o.recent.length === 0 ? <p className="muted text-sm">Noch keine Aufträge.</p> : (
          <table className="list text-sm">
            <thead><tr><th>Zeitpunkt</th><th>Aufgabe</th><th>Modell</th><th>Status</th><th>Elemente</th><th>Zurückgewiesen</th><th>Fehler</th></tr></thead>
            <tbody>
              {o.recent.map((j) => <tr key={j.id}><td>{fmtDateTime(j.startedAt)}</td><td>{jobTypeLabel[j.type] ?? j.type}</td><td>{j.model}</td><td><Status label={j.status} /></td><td>{j.itemCount ?? "–"}</td><td>{j.rejectedCount ?? "–"}</td><td className="muted">{j.error ?? ""}</td></tr>)}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
