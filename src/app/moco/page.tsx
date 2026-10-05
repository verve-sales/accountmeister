import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { canRunMocoImport } from "@/modules/moco/import";
import { hintKindLabel, listHints, mocoStatus, type HintKind } from "@/modules/moco/sync";
import { findDuplicateEngagements, findMisclassifiedFreelancers, listImports } from "@/modules/moco/import";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { fmtDateTime } from "@/lib/labels";
import { mocoDiscardImportAction, mocoHintsBulkAction, mocoPreviewAction, mocoPushLeadsAction, mocoRemoveDuplicatesAction, mocoRepairFreelancersAction, mocoSyncNowAction } from "../actions";
import { listLeadCandidates, type LeadOverview } from "@/modules/moco/leads";
import { opportunityStatusLabel } from "@/lib/labels";
import { Status } from "@/components/Status";
import { HintButtons } from "@/components/MocoHints";

const STATUS_LABEL: Record<string, string> = { ENTWURF: "Vorschau (offen)", UEBERNOMMEN: "übernommen", VERWORFEN: "verworfen" };

export default async function MocoPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const importer = canRunMocoImport(actor);
  const [status, hints, imports] = await Promise.all([mocoStatus(actor), listHints(actor, { status: "OFFEN" }), importer ? listImports(actor) : Promise.resolve([])]);
  if (!importer && hints.length === 0) notFound();
  const repair = importer && status.enabled ? await findMisclassifiedFreelancers(actor).catch(() => []) : [];
  const dupes = importer ? await findDuplicateEngagements(actor).catch(() => []) : [];
  let leads: LeadOverview | null = null;
  let leadsError: string | null = null;
  if (importer && status.enabled) {
    try {
      leads = await listLeadCandidates(actor);
    } catch (e) {
      leadsError = e instanceof Error ? e.message : String(e);
    }
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Moco</h1>
        <span className="muted text-sm">Moco führt Stammdaten, Projekte, Zuweisungen und Zeiten; der Accountmeister führt Vertrieb, Besetzung und Betreuung. Abgleich nur in Richtung Moco → Accountmeister, nie stillschweigend.</span>
      </div>
      <Feedback params={sp} />

      {importer && (
        <section className="card text-sm space-y-2">
          <h2 className="font-semibold">Verbindung</h2>
          <p>
            Modus: <strong>{status.mode}</strong>
            {status.subdomain ? ` · ${status.subdomain}.mocoapp.com` : ""} · Webhook-Signatur {status.webhookConfigured ? "hinterlegt" : "fehlt (MOCO_WEBHOOK_SECRET)"} · letzter Abgleich: {status.lastRun ? `${fmtDateTime(status.lastRun.startedAt)} (${status.lastRun.ok ? "ok" : `Fehler: ${status.lastRun.error}`})` : "noch keiner"}
          </p>
          {!status.enabled && <p className="muted">Die Anbindung ist aus. In <code>.env.production</code> setzen: <code>MOCO_MODE=http</code>, <code>MOCO_SUBDOMAIN</code>, <code>MOCO_API_KEY</code> (technischer Nutzer; schreibt nur Leads), optional <code>MOCO_WEBHOOK_SECRET</code>. Webhook-Ziel: <code>/api/moco/webhook</code> (Targets Project, Company, User; Events create/update/delete).</p>}
          {status.enabled && (
            <div className="flex flex-wrap gap-3 items-end">
              <form action={mocoPreviewAction}>
                <input type="hidden" name="back" value="/moco" />
                <button className="btn btn-small" type="submit">Vorschau aus Moco laden (Prüfliste)</button>
              </form>
              <form action={mocoSyncNowAction} className="flex gap-2 items-end">
                <input type="hidden" name="back" value="/moco" />
                <div><label className="label" htmlFor="since">Abgleich ab (leer = seit letztem Lauf)</label><input id="since" type="date" name="since" className="input" /></div>
                <button className="btn btn-secondary btn-small" type="submit">Abgleich jetzt</button>
              </form>
            </div>
          )}
          {status.events.length > 0 && <p className="muted text-xs">Letzte Webhook-Ereignisse: {status.events.map((e) => `${e.target}/${e.event}${e.signatureOk ? "" : " (Signatur!)"}${e.error ? " ✗" : ""}`).join(" · ")}</p>}
        </section>
      )}

      {dupes.length > 0 && (
        <section className="card" id="dubletten" style={{ borderColor: "#c0392b" }}>
          <h2 className="font-semibold mb-1">Dubletten aus Mehrfach-Import ({dupes.reduce((n, g) => n + g.remove.length, 0)})</h2>
          <p className="text-sm muted mb-2">Mehrere Einsätze zeigen auf dieselbe Moco-Zuweisung. Behalten wird je Zuweisung der Einsatz mit Unterlagen/bestätigten Perioden/erledigten Check-ins, sonst der älteste; die übrigen werden samt Position, Kandidatur, Auftrag und (wenn sonst leer) Chance entfernt.</p>
          <form action={mocoRemoveDuplicatesAction} className="space-y-2 text-sm">
            <input type="hidden" name="back" value="/moco" />
            <ul className="space-y-1">
              {dupes.map((g) => (
                <li key={g.mocoContractId}>
                  <span className="muted text-xs">Contract {g.mocoContractId} · behalten: </span><Link href={`/einsaetze/${g.keep.id}`}>{g.keep.title}</Link>
                  {g.remove.map((r) => (
                    <label key={r.id} className="ml-3 inline-flex items-center gap-1"><input type="checkbox" name="engagementId" value={r.id} defaultChecked /> entfernen: <Link href={`/einsaetze/${r.id}`}>{r.title}</Link> <span className="muted text-xs">({fmtDateTime(r.createdAt)})</span></label>
                  ))}
                </li>
              ))}
            </ul>
            <button className="btn btn-small" type="submit">Ausgewählte Dubletten entfernen</button>
          </form>
        </section>
      )}

      {repair.length > 0 && (
        <section className="card" id="freelancer-korrektur" style={{ borderColor: "#b7791f" }}>
          <h2 className="font-semibold mb-1">Freelancer-Korrektur ({repair.length})</h2>
          <p className="text-sm muted mb-2">Diese Personen sind laut Moco Freelancer (Team bzw. Extern-Kennzeichen), wurden aber als interne Zugänge angelegt. Die Korrektur legt sie im Freelancer-Pool an, hängt ihre Einsätze um (intern → Freelancer, EK leer, Check-ins Kunde + Freelancer) und deaktiviert den Zugang.</p>
          <form action={mocoRepairFreelancersAction} className="space-y-2 text-sm">
            <input type="hidden" name="back" value="/moco" />
            <ul className="space-y-1">
              {repair.map((r) => (
                <li key={r.userId}><label className="flex items-center gap-2"><input type="checkbox" name="userId" value={r.userId} defaultChecked /> <strong>{r.name}</strong> <span className="muted text-xs">{r.email}{r.unit ? ` · Moco-Team ${r.unit}` : ""} · {r.engagements} Einsatz/Einsätze</span></label></li>
              ))}
            </ul>
            <button className="btn btn-small" type="submit">Ausgewählte in den Freelancer-Pool überführen</button>
          </form>
        </section>
      )}

      {importer && status.enabled && (
        <section className="card" id="leads">
          <details>
            <summary className="font-semibold">Chancen als Leads nach Moco übertragen ({leads ? leads.candidates.filter((c) => c.ready).length : "–"} bereit{leads && leads.candidates.some((c) => !c.ready) ? `, ${leads.candidates.filter((c) => !c.ready).length} blockiert` : ""})</summary>
            <p className="text-sm muted mt-1 mb-2">Offene Chancen (antizipiert bis Auswahl/Bestellung, zurückgestellt) werden einmalig als Lead in der Moco-Akquise angelegt – mit Firma, Verantwortlicher/m als Lead-Inhaber, der vorgeschlagenen Phase und einem Verweis zurück auf die Chance. Beträge werden nicht erfunden (0 €, in Moco nachtragen). Gibt es bei der Firma schon einen Lead gleichen Namens, wird nur verknüpft. Die Chance bleibt im Accountmeister führend.</p>
            {leadsError && <p className="text-sm" style={{ color: "#c0392b" }}>Moco nicht erreichbar: {leadsError}</p>}
            {leads && leads.candidates.length === 0 && <p className="muted text-sm">Keine offene Chance ohne Moco-Lead.</p>}
            {leads && leads.candidates.length > 0 && (
              <form action={mocoPushLeadsAction} className="space-y-2 text-sm">
                <input type="hidden" name="back" value="/moco#leads" />
                <table className="list text-sm">
                  <thead><tr><th></th><th>Chance</th><th>Kunde → Moco-Firma</th><th>Status</th><th>Lead-Phase in Moco</th><th>Hinweis</th></tr></thead>
                  <tbody>
                    {leads.candidates.map((c) => (
                      <tr key={c.opportunityId}>
                        <td><input type="checkbox" name="opportunityId" value={c.opportunityId} defaultChecked={c.ready && c.status !== "ZURUECKGESTELLT"} disabled={!c.ready} aria-label={`${c.title} übertragen`} /></td>
                        <td><Link href={`/bedarfe/${c.opportunityId}`}>{c.title}</Link><div className="muted text-xs">{c.setupTitle} · {c.ownerName}</div></td>
                        <td>{c.accountName}{c.company ? <div className="muted text-xs">→ {c.company.name}{c.company.source === "VORSCHLAG" ? " (Namensgleichheit, wird verknüpft)" : ""}</div> : <div className="text-xs" style={{ color: "#c0392b" }}>keine Moco-Firma</div>}</td>
                        <td><Status label={opportunityStatusLabel[c.status] ?? c.status} /></td>
                        <td>
                          {c.existingDeal ? <span className="muted text-xs">vorhanden: {c.existingDeal.name} (#{c.existingDeal.id}) – nur verknüpfen</span> : (
                            <select name={`cat.${c.opportunityId}`} className="input" defaultValue={c.suggestedCategoryId ?? ""} aria-label="Lead-Phase" disabled={!c.ready}>
                              {leads!.categories.map((k) => <option key={k.id} value={k.id}>{k.name} ({k.probability} %)</option>)}
                            </select>
                          )}
                        </td>
                        <td className="text-xs">{c.blocker ? <span style={{ color: "#c0392b" }}>{c.blocker}</span> : c.mocoUserId && leads!.actorMocoUserId === c.mocoUserId && c.ownerName !== actor.displayName ? <span className="muted">Inhaber in Moco: Sie (Verantwortliche/r ohne Moco-Nutzer)</span> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button className="btn btn-small" type="submit">Ausgewählte Chancen nach Moco übertragen</button>
              </form>
            )}
          </details>
        </section>
      )}

      <section className="card" id="hinweise">
        <h2 className="font-semibold mb-2">Offene Hinweise aus Moco ({hints.length})</h2>
        {hints.filter((h) => h.kind === "ENDE_UEBERSCHRITTEN").length > 1 && (
          <form action={mocoHintsBulkAction} className="mb-2 flex flex-wrap gap-2 items-center text-sm">
            <input type="hidden" name="back" value="/moco" /><input type="hidden" name="kind" value="ENDE_UEBERSCHRITTEN" /><input type="hidden" name="decision" value="UEBERNEHMEN" />
            <span>{hints.filter((h) => h.kind === "ENDE_UEBERSCHRITTEN").length} Einsätze sind über ihr geplantes Ende hinaus aktiv.</span>
            <button className="btn btn-small" type="submit">Alle zum geplanten Ende beenden</button>
          </form>
        )}
        {hints.length === 0 ? (
          <p className="muted text-sm">Keine Abweichungen. Hinweise entstehen, wenn Moco ein Projektende ändert, ein Projekt beendet, eine Zuweisung inaktiv setzt oder etwas Neues anlegt.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {hints.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline gap-2">
                <span className="status">{hintKindLabel[h.kind as HintKind] ?? h.kind}</span>
                <span>{h.title}</span>
                {h.subjectType === "ENGAGEMENT" && h.subjectId && <Link href={`/einsaetze/${h.subjectId}`} className="text-xs">Einsatz öffnen</Link>}
                <span className="muted text-xs">{fmtDateTime(h.createdAt)}</span>
                <HintButtons id={h.id} kind={h.kind as HintKind} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {importer && (
        <section className="card">
          <h2 className="font-semibold mb-2">Importläufe</h2>
          {imports.length === 0 ? <p className="muted text-sm">Noch kein Importlauf.</p> : (
            <ul className="space-y-1 text-sm">
              {imports.map((i) => (
                <li key={i.id} className="flex flex-wrap items-baseline gap-2">
                  <Link href={`/moco/import/${i.id}`}>{i.summary ?? i.id}</Link>
                  <span className="status">{STATUS_LABEL[i.status] ?? i.status}</span>
                  <span className="muted text-xs">{fmtDateTime(i.createdAt)}</span>
                  {i.status === "ENTWURF" && (
                    <form action={mocoDiscardImportAction} className="inline"><input type="hidden" name="importId" value={i.id} /><input type="hidden" name="back" value="/moco" /><button className="btn btn-secondary btn-small" type="submit">Verwerfen</button></form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

