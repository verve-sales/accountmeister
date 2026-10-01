import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { DomainError } from "@/lib/errors";
import { getConfig } from "@/lib/config";
import { docSideLabel, docTypeLabel, docTypeValues, engagementStatusLabel, getEngagementDetail, signedStatusLabel, careRoleLabel } from "@/modules/engagements/service";
import { checkinStatusLabel, renewalStatusLabel } from "@/modules/engagements/care";
import { scopeUnitLabel, rateUnitLabel } from "@/modules/staffing/service";
import { workTargets } from "@/modules/work/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Comments } from "@/components/Work";
import { fmtDate, fmtDateTime } from "@/lib/labels";
import { addContractDocumentAction, addPeriodAction, changeEngagementStatusAction, checkinAction, createCheckinAction, linkContractDocumentAction, renewalDecisionAction, requestCareHandoverAction, setCareDirectAction, setContractDocumentStatusAction, updateEngagementAction } from "../../actions";

const eur = (v: string | null, unit: string) => (v ? `${Number(v).toLocaleString("de-DE", { maximumFractionDigits: 2 })} ${rateUnitLabel[unit] ?? unit}` : "offen");
const RED = "#c0392b";

function Btn({ id, version, back, status, label, secondary, fields }: { id: string; version: number; back: string; status: string; label: string; secondary?: boolean; fields?: React.ReactNode }) {
  return (
    <form action={changeEngagementStatusAction} className="flex flex-wrap gap-2 items-end">
      <input type="hidden" name="engagementId" value={id} /><input type="hidden" name="version" value={version} /><input type="hidden" name="back" value={back} /><input type="hidden" name="status" value={status} />
      {fields}
      <button className={`btn btn-small${secondary ? " btn-secondary" : ""}`} type="submit">{label}</button>
    </form>
  );
}

export default async function EinsatzPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  if (getConfig().FEATURE_BESETZUNG !== "true") notFound();
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let d;
  try {
    d = await getEngagementDetail(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const { view: e, access: a } = d;
  const back = `/einsaetze/${id}`;
  const final = ["ABGESCHLOSSEN", "ABGEBROCHEN"].includes(e.status);
  const targets = await workTargets(actor);
  const openRenewal = d.renewals.find((r) => ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"].includes(r.status));
  const vertrag = e.procurement.complete === true ? "vollständig" : e.procurementException ? `Ausnahme: ${e.procurementException}` : e.procurement.complete === false ? `unvollständig (${e.procurement.required.filter((r) => r.ok).length}/${e.procurement.required.length})` : "kein freigegebenes Beschaffungsprofil – Stand unbestimmt";
  const nextDue = [e.nextCheckin, openRenewal ? e.pingDate : null, e.status === "PAUSIERT" ? e.reviewDate : null].filter((x): x is string => !!x).sort()[0] ?? null;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm"><Link href="/einsaetze">Einsätze</Link> · <Link href={`/kunden/${e.accountId}`}>{e.accountName}</Link> · <Link href={`/besetzung/${e.positionId}`}>Position</Link> · <Link href={`/bedarfe/${e.opportunityId}#auftrag`}>Chance / Auftrag</Link></p>
        <h1 className="text-2xl font-semibold mt-1">{e.title}</h1>
        <div className="flex flex-wrap gap-x-4 gap-y-1 items-baseline mt-1 text-sm">
          <span className="status">{engagementStatusLabel[e.status] ?? e.status}</span>
          <span>Freelancer: <Link href={`/besetzung/freelancer/${e.freelancerId}`}>{e.freelancerName}</Link></span>
          <span>Betreuung: {e.careNames.length ? e.careNames.join(", ") : <span style={{ color: RED }}>offen</span>}</span>
          <span>Laufzeit: {fmtDate(e.actualStart ?? e.plannedStart)} – {e.plannedEnd ? `${fmtDate(e.plannedEnd)}${e.daysToEnd !== null ? ` (${e.daysToEnd} Tage)` : ""}` : "offen"}</span>
          {nextDue && <span style={nextDue < new Date().toISOString().slice(0, 10) ? { color: RED, fontWeight: 600 } : undefined}>nächste Frist {fmtDate(nextDue)}</span>}
          <span className="muted text-xs ml-auto">{a.manage ? "BD-Kontext" : `Betreuung (${a.careRoles.map((r) => careRoleLabel[r]).join(", ")})`}</span>
        </div>
      </div>
      <Feedback params={sp} />

      {/* Überblick */}
      <section className="card">
        <dl className="text-sm grid sm:grid-cols-3 gap-x-6 gap-y-2">
          <div><dt className="muted">Verantwortlicher BD</dt><dd>{e.bdName}</dd></div>
          <div><dt className="muted">Vertragslage</dt><dd style={e.procurement.complete === true ? undefined : { color: "#b7791f" }}>{vertrag}</dd></div>
          <div><dt className="muted">Verlängerung</dt><dd>{openRenewal ? `${renewalStatusLabel[openRenewal.status]} (Auslöser ${fmtDate(openRenewal.triggerDate)})` : e.pingDate ? `Klärung ab ${fmtDate(e.pingDate)}` : "kein Ende hinterlegt"}</dd></div>
          <div><dt className="muted">Kündigungs-/Optionsfrist</dt><dd>{e.renewalDeadline ? `${fmtDate(e.renewalDeadline)}${e.noticeNote ? ` – ${e.noticeNote}` : ""}` : "unbekannt – bitte klären"}</dd></div>
          <div><dt className="muted">Auftrag/Bestellung (Chance)</dt><dd>{e.orderId ? (d.orders.find((o) => o.id === e.orderId)?.orderReference ?? "verknüpft") : "nicht verknüpft"}</dd></div>
          <div><dt className="muted">Externe Referenz (z. B. Moco)</dt><dd>{e.externalRef ? (/^https?:\/\//.test(e.externalRef) ? <a href={e.externalRef} target="_blank" rel="noreferrer">{e.externalRef}</a> : e.externalRef) : "keine – Stundenzettel laufen in Moco"}</dd></div>
          {e.statusReason && <div className="sm:col-span-3"><dt className="muted">Hinweis zum Status</dt><dd>{e.statusReason}{e.reviewDate ? ` · Prüftermin ${fmtDate(e.reviewDate)}` : ""}</dd></div>}
        </dl>
        {a.manage && !final && (
          <details className="mt-3">
            <summary>Stammdaten bearbeiten</summary>
            <form action={updateEngagementAction} className="grid sm:grid-cols-3 gap-2 mt-2">
              <input type="hidden" name="engagementId" value={id} /><input type="hidden" name="version" value={e.version} /><input type="hidden" name="back" value={back} />
              <div className="sm:col-span-3"><label className="label">Titel</label><input name="title" className="input" defaultValue={e.title} required /></div>
              <div><label className="label">Geplanter Start</label><input type="date" name="plannedStart" className="input" defaultValue={e.plannedStart ?? ""} /></div>
              <div><label className="label">Geplantes Ende</label><input type="date" name="plannedEnd" className="input" defaultValue={e.plannedEnd ?? ""} /></div>
              <div><label className="label">Kündigungs-/Optionsfrist</label><input type="date" name="renewalDeadline" className="input" defaultValue={e.renewalDeadline ?? ""} /></div>
              <div><label className="label">Fristhinweis</label><input name="noticeNote" className="input" defaultValue={e.noticeNote ?? ""} placeholder="z. B. 4 Wochen zum Monatsende" /></div>
              <div><label className="label">Externe Referenz</label><input name="externalRef" className="input" defaultValue={e.externalRef ?? ""} /></div>
              <div>
                <label className="label">Auftrag/Bestellung der Chance</label>
                <select name="orderId" className="input" defaultValue={e.orderId ?? ""}><option value="">–</option>{d.orders.map((o) => <option key={o.id} value={o.id}>{o.orderReference ?? o.id.slice(0, 8)} · {o.status}</option>)}</select>
              </div>
              <div>
                <label className="label">Verantwortlicher BD</label>
                <select name="bdUserId" className="input" defaultValue={e.bdUserId}>{d.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
              </div>
              <div className="sm:col-span-3"><button className="btn btn-small" type="submit">Speichern</button></div>
            </form>
          </details>
        )}
      </section>

      {/* Status */}
      {a.manage && !final && (
        <section className="card text-sm space-y-3">
          <h2 className="font-semibold">Status</h2>
          <div className="flex flex-wrap gap-4 items-end">
            {e.status === "VORBEREITUNG" && <Btn id={id} version={e.version} back={back} status="GEPLANT" label="Auf „geplant“ setzen" fields={e.procurement.complete === true ? null : <div><label className="label">Ausnahme vom Beschaffungscheck (Grund)</label><input name="exception" className="input" placeholder="nur wenn Unterlagen bewusst fehlen" style={{ minWidth: 320 }} /></div>} />}
            {e.status === "GEPLANT" && <Btn id={id} version={e.version} back={back} status="AKTIV" label="Start bestätigen" fields={<div><label className="label">Tatsächlicher Start</label><input type="date" name="actualDate" className="input" required /></div>} />}
            {e.status === "GEPLANT" && <Btn id={id} version={e.version} back={back} status="VORBEREITUNG" label="Zurück in Vorbereitung" secondary />}
            {e.status === "PAUSIERT" && <Btn id={id} version={e.version} back={back} status="AKTIV" label="Fortsetzen" />}
            {(e.status === "AKTIV") && <Btn id={id} version={e.version} back={back} status="PAUSIERT" label="Pausieren" secondary fields={<><input name="reason" className="input" placeholder="Grund" required /><div><label className="label">Prüftermin</label><input type="date" name="reviewDate" className="input" required /></div></>} />}
            {["AKTIV", "PAUSIERT"].includes(e.status) && <Btn id={id} version={e.version} back={back} status="ENDET" label="Ende bestätigen" secondary fields={<div><label className="label">Bestätigtes Enddatum</label><input type="date" name="actualDate" className="input" required /></div>} />}
            {e.status === "ENDET" && <Btn id={id} version={e.version} back={back} status="ABGESCHLOSSEN" label="Abschließen" fields={<input name="reason" className="input" placeholder="Abschlussnotiz (bei offenen Punkten Pflicht)" style={{ minWidth: 280 }} />} />}
            {e.status === "ENDET" && <Btn id={id} version={e.version} back={back} status="AKTIV" label="Doch weiter (aktiv)" secondary />}
            {!["ENDET"].includes(e.status) && <Btn id={id} version={e.version} back={back} status="ABGEBROCHEN" label="Abbrechen" secondary fields={<input name="reason" className="input" placeholder="Grund (Pflicht)" required />} />}
          </div>
          <p className="muted text-xs">„Geplant“ setzt Betreuung und Vertragslage nach Beschaffungsprofil voraus (oder eine begründete Ausnahme). „Aktiv“ ist ein bestätigtes Ereignis, kein Datumsablauf. Verlängerung ist kein Status – der Einsatz bleibt aktiv, während sie geklärt wird.</p>
        </section>
      )}

      {/* Betreuung */}
      <section className="card" id="betreuung">
        <h2 className="font-semibold mb-2">Betreuung</h2>
        <ul className="text-sm space-y-1">
          {d.cares.map((c) => (
            <li key={c.id} className={c.toDate ? "muted" : ""}>{careRoleLabel[c.role] ?? c.role}: <strong>{c.name}</strong> seit {fmtDate(c.fromDate)}{c.toDate ? ` bis ${fmtDate(c.toDate)}${c.endedReason ? ` (${c.endedReason})` : ""}` : ""} · erteilt von {c.grantedName}{c.handoverWorkItemId ? <> · <Link href={`/vorgaenge/${c.handoverWorkItemId}`}>Übergabe</Link></> : ""}</li>
          ))}
          {d.cares.length === 0 && <li className="muted">Noch keine Betreuung zugeordnet.</li>}
        </ul>
        {!final && (a.manage || a.care) && (
          <details className="mt-3">
            <summary>Betreuung übergeben (Vorgang mit Annahme)</summary>
            <form action={requestCareHandoverAction} className="grid sm:grid-cols-2 gap-2 mt-2">
              <input type="hidden" name="engagementId" value={id} /><input type="hidden" name="back" value={`${back}#betreuung`} />
              <div><label className="label">Funktion</label><select name="role" className="input" defaultValue="CUSTOMER_CARE"><option value="CUSTOMER_CARE">Kundenbetreuung</option><option value="FREELANCER_CARE">Freelancer-Betreuung</option></select></div>
              <div>
                <label className="label">An</label>
                <select name="target" className="input" defaultValue="">
                  <option value="" disabled>bitte wählen</option>
                  {targets.teams.map((t) => <option key={t.id} value={`team:${t.id}`}>{t.name} (Team)</option>)}
                  {targets.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2"><label className="label">Grund</label><input name="reason" className="input" required minLength={5} /></div>
              <div><label className="label">Relevante Kontakte</label><input name="contacts" className="input" /></div>
              <div><label className="label">Erlaubte Gesprächshistorie</label><input name="history" className="input" /></div>
              <div><label className="label">Offene Zusagen / Risiken</label><input name="commitments" className="input" /></div>
              <div><label className="label">Nächste Aufgabe / Termin</label><input name="nextStep" className="input" /></div>
              <div><label className="label">Annahme bis</label><input type="date" name="dueDate" className="input" /></div>
              <div className="sm:col-span-2"><button className="btn btn-small" type="submit">Übergabe anfragen</button></div>
            </form>
          </details>
        )}
        {a.manage && !final && (
          <details className="mt-2">
            <summary>Direkt umstellen (ohne Übergabe, z. B. Korrektur)</summary>
            <form action={setCareDirectAction} className="flex flex-wrap gap-2 items-end mt-2">
              <input type="hidden" name="engagementId" value={id} /><input type="hidden" name="back" value={`${back}#betreuung`} />
              <select name="role" className="input" defaultValue="CUSTOMER_CARE" aria-label="Funktion"><option value="CUSTOMER_CARE">Kundenbetreuung</option><option value="FREELANCER_CARE">Freelancer-Betreuung</option></select>
              <select name="userId" className="input" defaultValue="" aria-label="Person"><option value="">– beenden ohne Nachfolge –</option>{d.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
              <input name="reason" className="input" placeholder="Grund" />
              <button className="btn btn-secondary btn-small" type="submit">Umstellen</button>
            </form>
          </details>
        )}
      </section>

      {/* Verträge */}
      <section className="card" id="vertraege">
        <div className="flex flex-wrap items-baseline gap-2 mb-2">
          <h2 className="font-semibold">Verträge und Bestellungen</h2>
          <span className="muted text-xs">Zwei Vertragsseiten, getrennt von den Dokumenten. {e.procurement.profile ? `Pflicht laut Profil: ${e.procurement.required.map((r) => `${docSideLabel[r.side]} ${docTypeLabel[r.docType]}${r.ok ? " ✓" : ""}`).join(", ") || "keine"}.` : <>Kein freigegebenes Beschaffungsprofil – <Link href={`/kunden/${e.accountId}#beschaffungsprofil`}>am Kunden pflegen</Link>.</>}</span>
        </div>
        {d.documents.length === 0 ? <p className="muted text-sm">Noch keine Unterlage verknüpft.</p> : (
          <ul className="text-sm space-y-2">
            {d.documents.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-baseline gap-2">
                <strong>{doc.title}</strong><span className="status">{signedStatusLabel[doc.signedStatus] ?? doc.signedStatus}</span>
                <span className="muted text-xs">{docSideLabel[doc.side]} · {docTypeLabel[doc.docType]}{doc.versionLabel ? ` · ${doc.versionLabel}` : ""}{doc.reference ? ` · Nr. ${doc.reference}` : ""}{doc.validFrom || doc.validTo ? ` · ${fmtDate(doc.validFrom)} – ${fmtDate(doc.validTo)}` : ""}</span>
                {doc.sourceId && <Link href={`/quellen/${doc.sourceId}`} className="text-xs">Dokument</Link>}
                {doc.link && <a href={doc.link} target="_blank" rel="noreferrer" className="text-xs">Ablage</a>}
                {!!doc.suggestion && (doc.suggestion as { docType?: string; extractStatus?: string }).extractStatus === "LEER" && <span className="text-xs" style={{ color: "#b7791f" }}>Scan – nicht ausgewertet</span>}
                {a.manage && !final && doc.signedStatus !== "UNTERSCHRIEBEN" && (
                  <form action={setContractDocumentStatusAction} className="inline-flex gap-1 items-center">
                    <input type="hidden" name="engagementId" value={id} /><input type="hidden" name="documentId" value={doc.id} /><input type="hidden" name="version" value={doc.version} /><input type="hidden" name="back" value={`${back}#vertraege`} />
                    <select name="signedStatus" className="input" defaultValue={doc.signedStatus} aria-label="Status"><option value="ENTWURF">Entwurf</option><option value="VERSENDET">versendet</option><option value="UNTERSCHRIEBEN">unterschrieben</option><option value="GEKUENDIGT">gekündigt</option></select>
                    {!doc.sourceId && !doc.link && <input name="link" className="input" placeholder="Link zum Beleg" />}
                    <button className="btn btn-secondary btn-small" type="submit">Setzen</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {!final && (a.manage || a.care) && (
          <>
            <details className="mt-3">
              <summary>Unterlage hinzufügen (Datei oder Link)</summary>
              <form action={addContractDocumentAction} className="grid sm:grid-cols-3 gap-2 mt-2" encType="multipart/form-data">
                <input type="hidden" name="engagementId" value={id} /><input type="hidden" name="back" value={`${back}#vertraege`} />
                <div><label className="label">Seite</label><select name="side" className="input" defaultValue="KUNDE"><option value="KUNDE">Kunde ↔ Verve</option><option value="FREELANCER">Verve ↔ Freelancer</option></select></div>
                <div><label className="label">Typ</label><select name="docType" className="input" defaultValue="BESTELLUNG">{docTypeValues.map((t) => <option key={t} value={t}>{docTypeLabel[t]}</option>)}</select></div>
                <div><label className="label">Status</label><select name="signedStatus" className="input" defaultValue="ENTWURF"><option value="ENTWURF">Entwurf</option><option value="VERSENDET">versendet</option><option value="UNTERSCHRIEBEN">unterschrieben (Beleg nötig)</option></select></div>
                <div className="sm:col-span-2"><label className="label">Titel</label><input name="title" className="input" required /></div>
                <div><label className="label">Version / Stand</label><input name="versionLabel" className="input" /></div>
                <div><label className="label">Nummer</label><input name="reference" className="input" /></div>
                <div><label className="label">Gültig ab</label><input type="date" name="validFrom" className="input" /></div>
                <div><label className="label">Gültig bis</label><input type="date" name="validTo" className="input" /></div>
                <div className="sm:col-span-2"><label className="label">Datei (PDF, DOCX, TXT …)</label><input type="file" name="file" className="input" /></div>
                <div><label className="label">oder Link zum führenden Ablageort</label><input name="link" className="input" /></div>
                <div className="sm:col-span-3"><label className="label">Prüfnotiz</label><input name="reviewNote" className="input" /></div>
                <div className="sm:col-span-3"><button className="btn btn-small" type="submit">Speichern</button> <span className="muted text-xs">Aus dem Dateitext wird ein Typ vorgeschlagen; Scans werden erkannt, aber nicht ausgewertet.</span></div>
              </form>
            </details>
            {d.otherAccountDocuments.length > 0 && (
              <details className="mt-2">
                <summary>Bestehende Unterlage des Kunden verknüpfen ({d.otherAccountDocuments.length})</summary>
                <ul className="text-sm mt-2 space-y-1">
                  {d.otherAccountDocuments.map((doc) => (
                    <li key={doc.id} className="flex flex-wrap gap-2 items-center">
                      {doc.title} · {docSideLabel[doc.side]} · {docTypeLabel[doc.docType]} · {signedStatusLabel[doc.signedStatus]}
                      <form action={linkContractDocumentAction}><input type="hidden" name="engagementId" value={id} /><input type="hidden" name="documentId" value={doc.id} /><input type="hidden" name="back" value={`${back}#vertraege`} /><button className="btn btn-secondary btn-small" type="submit">Verknüpfen</button></form>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>

      {/* Konditionen */}
      <section className="card" id="konditionen">
        <h2 className="font-semibold mb-2">Konditionen und Perioden</h2>
        <table className="list text-sm">
          <thead><tr><th>Art</th><th>Gültig</th><th>EK</th><th>VK</th><th>Umfang</th><th>Quelle</th><th>Bestätigt</th></tr></thead>
          <tbody>
            {d.periods.map((p) => (
              <tr key={p.id} className={p.supersededById ? "muted" : ""}>
                <td>{p.kind === "BESTAETIGT" ? "bestätigt" : "Plan"}{p.supersededById ? " (abgelöst)" : ""}</td>
                <td>{fmtDate(p.validFrom)} – {p.validTo ? fmtDate(p.validTo) : "offen"}</td>
                <td>{eur(p.ek, p.rateUnit)}</td>
                <td>{eur(p.vk, p.rateUnit)}</td>
                <td>{p.scopeAmount ? `${p.scopeAmount} ${scopeUnitLabel[p.scopeUnit ?? ""] ?? ""}` : "–"}</td>
                <td>{p.source ?? "–"}{p.note ? ` · ${p.note}` : ""}</td>
                <td>{p.confirmedName ? `${p.confirmedName}, ${fmtDate(p.confirmedAt)}` : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted text-xs mt-2">Keine Umsatzhochrechnung: Sätze, Laufzeit und Menge stehen hier getrennt; eine Summe gibt es nur mit bekannter Einsatzmenge.</p>
        {a.manage && !final && (
          <details className="mt-2">
            <summary>Neue Periode (Satzänderung, Verlängerung, Bestätigung)</summary>
            <form action={addPeriodAction} className="grid sm:grid-cols-4 gap-2 mt-2">
              <input type="hidden" name="engagementId" value={id} /><input type="hidden" name="back" value={`${back}#konditionen`} />
              <div><label className="label">Art</label><select name="kind" className="input" defaultValue="BESTAETIGT"><option value="PLAN">Plan</option><option value="BESTAETIGT">bestätigt</option></select></div>
              <div><label className="label">Gültig ab</label><input type="date" name="validFrom" className="input" required /></div>
              <div><label className="label">Gültig bis</label><input type="date" name="validTo" className="input" /></div>
              <div><label className="label">je</label><select name="rateUnit" className="input" defaultValue="TAG"><option value="TAG">Tag</option><option value="STUNDE">Stunde</option></select></div>
              <div><label className="label">EK</label><input name="ek" className="input" inputMode="decimal" /></div>
              <div><label className="label">VK</label><input name="vk" className="input" inputMode="decimal" /></div>
              <div><label className="label">Umfang</label><input type="number" name="scopeAmount" className="input" /></div>
              <div><label className="label">Einheit</label><select name="scopeUnit" className="input" defaultValue="TAGE_PRO_WOCHE">{Object.entries(scopeUnitLabel).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              <div><label className="label">Löst ab</label><select name="supersedesId" className="input" defaultValue=""><option value="">–</option>{d.periods.filter((p) => !p.supersededById).map((p) => <option key={p.id} value={p.id}>{fmtDate(p.validFrom)} – {p.validTo ? fmtDate(p.validTo) : "offen"} ({p.kind})</option>)}</select></div>
              <div className="sm:col-span-2"><label className="label">Quelle / Notiz</label><input name="source" className="input" placeholder="z. B. Nachtrag 1 vom …" /></div>
              <label className="text-sm flex items-center gap-2 self-end"><input type="checkbox" name="correction" value="on" /> Korrektur (Überlappung bewusst)</label>
              <div className="sm:col-span-4"><button className="btn btn-small" type="submit">Periode anlegen</button></div>
            </form>
          </details>
        )}
      </section>

      {/* Check-ins */}
      <section className="card" id="checkins">
        <h2 className="font-semibold mb-2">Check-ins</h2>
        <p className="muted text-xs mb-2">Kunden-Catch-up alle 42 Tage nach dem letzten tatsächlichen Gespräch (Startwert); Freelancer-Check-ins separat. Verschieben ändert nicht den letzten Kontakt.</p>
        {d.checkins.length === 0 && <p className="muted text-sm">Noch keine Check-ins.</p>}
        <ul className="space-y-3 text-sm">
          {d.checkins.map((c) => {
            const open = ["FAELLIG", "ANGEFRAGT", "GEPLANT"].includes(c.status);
            const may = a.manage || c.ownerUserId === actor.userId;
            return (
              <li key={c.id} className="border rounded-md p-2" style={{ borderColor: open && c.dueDate < new Date().toISOString().slice(0, 10) ? RED : "var(--border)" }}>
                <div className="flex flex-wrap gap-2 items-baseline">
                  <strong>{c.side === "KUNDE" ? "Kunde" : "Freelancer"}</strong><span className="status">{checkinStatusLabel[c.status] ?? c.status}</span>
                  <span className="muted text-xs">fällig {fmtDate(c.dueDate)} · {c.ownerName}{c.scheduledAt ? ` · geplant ${fmtDateTime(c.scheduledAt)}` : ""}{c.heldAt ? ` · geführt ${fmtDateTime(c.heldAt)}` : ""}{c.participants ? ` · ${c.participants}` : ""}</span>
                </div>
                {c.note && <div style={{ whiteSpace: "pre-wrap" }}>{c.note}</div>}
                {c.risks && <div><span className="muted">Risiken:</span> {c.risks}</div>}
                {c.openPoints && <div><span className="muted">Offene Punkte:</span> {c.openPoints}</div>}
                {c.nextStep && <div><span className="muted">Nächste Maßnahme:</span> {c.nextStep}</div>}
                {c.salesHint && <div><span className="muted">Sales-Hinweis:</span> {c.salesHint}{c.salesSignalId ? <> · <Link href={`/setups/${e.setupId}`}>als Signal zur Prüfung</Link></> : " (nicht als Signal angelegt – BD informiert)"}</div>}
                {open && may && !final && (
                  <details className="mt-1">
                    <summary>Bearbeiten</summary>
                    <form action={checkinAction} className="grid sm:grid-cols-3 gap-2 mt-2">
                      <input type="hidden" name="checkinId" value={c.id} /><input type="hidden" name="version" value={c.version} /><input type="hidden" name="back" value={`${back}#checkins`} />
                      <div><label className="label">Aktion</label><select name="action" className="input" defaultValue="ERLEDIGEN"><option value="ANFRAGEN">angefragt</option><option value="TERMINIEREN">terminieren</option><option value="ERLEDIGEN">erledigt (Gespräch geführt)</option><option value="VERSCHIEBEN">verschieben</option><option value="ABSAGEN">entfällt</option></select></div>
                      <div><label className="label">Geplanter Termin</label><input type="datetime-local" name="scheduledAt" className="input" /></div>
                      <div><label className="label">Tatsächlicher Termin</label><input type="datetime-local" name="heldAt" className="input" /></div>
                      <div><label className="label">Neues Datum (verschieben)</label><input type="date" name="newDueDate" className="input" /></div>
                      <div><label className="label">Teilnehmer</label><input name="participants" className="input" defaultValue={c.participants ?? ""} /></div>
                      <div><label className="label">Grund (verschieben/entfällt)</label><input name="reason" className="input" /></div>
                      <div className="sm:col-span-3"><label className="label">Ergebnis (sachlich)</label><textarea name="note" className="input" rows={2} /></div>
                      <div><label className="label">Risiken</label><input name="risks" className="input" /></div>
                      <div><label className="label">Offene Punkte</label><input name="openPoints" className="input" /></div>
                      <div><label className="label">Nächste Maßnahme</label><input name="nextStep" className="input" /></div>
                      <div className="sm:col-span-3"><label className="label">Sales-Hinweis (wird als Signal zur Prüfung an den BD gegeben)</label><input name="salesHint" className="input" placeholder="z. B. Bereich plant ab Q2 zwei weitere Rollen" /></div>
                      <div className="sm:col-span-3"><button className="btn btn-small" type="submit">Speichern</button></div>
                    </form>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
        {!final && (a.manage || a.care) && (
          <form action={createCheckinAction} className="flex flex-wrap gap-2 items-end mt-3">
            <input type="hidden" name="engagementId" value={id} /><input type="hidden" name="back" value={`${back}#checkins`} />
            <select name="side" className="input" defaultValue="KUNDE" aria-label="Seite"><option value="KUNDE">Kunde</option><option value="FREELANCER">Freelancer</option></select>
            <div><label className="label">Fällig</label><input type="date" name="dueDate" className="input" required /></div>
            <input name="note" className="input" placeholder="Anlass (optional)" />
            <button className="btn btn-secondary btn-small" type="submit">Check-in anlegen</button>
          </form>
        )}
      </section>

      {/* Verlängerung */}
      <section className="card" id="verlaengerung">
        <h2 className="font-semibold mb-2">Verlängerung</h2>
        {d.renewals.length === 0 ? <p className="muted text-sm">Noch keine Verlängerungsentscheidung. Sie entsteht automatisch {e.pingDate ? `ab ${fmtDate(e.pingDate)}` : "sobald ein Ende oder eine Frist hinterlegt ist"} (90 Tage vor Ende bzw. 30 Tage vor der Frist) – oder jetzt manuell.</p> : (
          <ul className="text-sm space-y-1">
            {d.renewals.map((r) => (
              <li key={r.id}><span className="status">{renewalStatusLabel[r.status] ?? r.status}</span> Auslöser {fmtDate(r.triggerDate)}{r.proposedFrom ? ` · Zeitraum ${fmtDate(r.proposedFrom)} – ${fmtDate(r.proposedTo)}` : ""}{r.conditionsNote ? ` · ${r.conditionsNote}` : ""}{r.availabilityNote ? ` · Verfügbarkeit: ${r.availabilityNote}` : ""}{r.contractFollowUp ? ` · Vertragsfolge: ${r.contractFollowUp}` : ""}{r.ownerName ? ` · kommerziell: ${r.ownerName}` : ""}{r.decidedAt ? ` · entschieden ${fmtDate(r.decidedAt)}` : ""}</li>
            ))}
          </ul>
        )}
        {!final && (a.manage || a.care) && (
          <details className="mt-2" open={!!openRenewal && openRenewal.triggerDate! <= new Date().toISOString().slice(0, 10)}>
            <summary>Stand fortschreiben</summary>
            <form action={renewalDecisionAction} className="grid sm:grid-cols-3 gap-2 mt-2">
              <input type="hidden" name="engagementId" value={id} /><input type="hidden" name="back" value={`${back}#verlaengerung`} />
              {openRenewal && <input type="hidden" name="version" value={openRenewal.version} />}
              <div><label className="label">Stand</label><select name="status" className="input" defaultValue={openRenewal ? "IN_ABSTIMMUNG" : "ZU_KLAEREN"}><option value="ZU_KLAEREN">zu klären</option><option value="IN_ABSTIMMUNG">in Abstimmung</option><option value="ANGEBOTEN">angeboten</option>{a.manage && <option value="BESTAETIGT">bestätigt (neue Periode)</option>}{a.manage && <option value="ABGELEHNT">abgelehnt</option>}<option value="ERLEDIGT">erledigt</option></select></div>
              <div><label className="label">Zeitraum von</label><input type="date" name="proposedFrom" className="input" defaultValue={openRenewal?.proposedFrom ?? ""} /></div>
              <div><label className="label">bis</label><input type="date" name="proposedTo" className="input" defaultValue={openRenewal?.proposedTo ?? ""} /></div>
              <div><label className="label">EK (bei Bestätigung)</label><input name="ek" className="input" inputMode="decimal" /></div>
              <div><label className="label">VK (bei Bestätigung)</label><input name="vk" className="input" inputMode="decimal" /></div>
              <div><label className="label">je</label><select name="rateUnit" className="input" defaultValue="TAG"><option value="TAG">Tag</option><option value="STUNDE">Stunde</option></select></div>
              <div><label className="label">Konditionsstand (Notiz)</label><input name="conditionsNote" className="input" defaultValue={openRenewal?.conditionsNote ?? ""} /></div>
              <div><label className="label">Verfügbarkeit Freelancer</label><input name="availabilityNote" className="input" defaultValue={openRenewal?.availabilityNote ?? ""} /></div>
              <div><label className="label">Vertragsfolge</label><input name="contractFollowUp" className="input" defaultValue={openRenewal?.contractFollowUp ?? ""} placeholder="z. B. Nachtrag, neue Bestellung" /></div>
              <div><label className="label">Kommerziell zuständig</label><select name="commercialOwnerUserId" className="input" defaultValue={openRenewal?.commercialOwnerUserId ?? e.bdUserId}>{d.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
              <div className="sm:col-span-3"><button className="btn btn-small" type="submit">Speichern</button> <span className="muted text-xs">Bestätigen und ablehnen liegt beim BD-Kontext; die Betreuung bereitet vor.</span></div>
            </form>
          </details>
        )}
      </section>

      <Comments actor={actor} subjectType="CHANCE" subjectId={e.opportunityId} back={back} />

      <section className="card">
        <details>
          <summary className="font-semibold">Verlauf ({d.history.length})</summary>
          <ul className="text-sm mt-2 space-y-1">
            {d.history.map((h, i) => (
              <li key={i}><span className="muted">{fmtDateTime(h.at)}</span> · {h.who}: {h.action.replace(/^(engagement|care|checkin|renewal|contract_document)\./, "")}{h.changes && "nach" in h.changes ? ` → ${engagementStatusLabel[String(h.changes.nach)] ?? String(h.changes.nach)}` : ""}</li>
            ))}
          </ul>
        </details>
      </section>
    </div>
  );
}
