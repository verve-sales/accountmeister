import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { getOpportunityDetail, MEDDPICC_KEYS } from "@/modules/opportunities/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { decisionRoleLabel, engagementStatusLabel, epistemicLabel, fmtDate, fmtDateTime, offerStatusLabel, opportunityStatusLabel, orderStatusLabel, requirementStatusLabel, sourceTypeLabel } from "@/lib/labels";
import {
  addParticipationAction, addStartRequirementAction, cancelOrderAction, changeOfferStatusAction, changeOpportunityStatusAction, confirmOpportunityAction, confirmOrderAction, createOfferAction,
  createOrderAction, markReadyAction, markStartedAction, orderEvidenceIncompleteAction, presentOfferAction, removeParticipationAction, saveMeddpiccAction, setRequirementStatusAction, updateOpportunityAction,
} from "../../actions";

const VERLAUF = ["IN_KLAERUNG", "BESTAETIGT", "PROFIL_ANGEBOT_VORGESTELLT", "AUSWAHL_BESTELLUNG", "BEAUFTRAGT"] as const;

function EvidenceFields({ prefix, sources, label = "Beleg" }: { prefix: string; sources: { id: string; title: string; type: string }[]; label?: string }) {
  return (
    <>
      <div>
        <label className="label" htmlFor={`${prefix}Source`}>{label}: vorhandene Quelle</label>
        <select id={`${prefix}Source`} name="sourceId" className="select" defaultValue="">
          <option value="">– keine, Belegnotiz unten –</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{sourceTypeLabel[s.type] ?? s.type}: {s.title}</option>)}
        </select>
      </div>
      <div><label className="label" htmlFor={`${prefix}Text`}>oder Belegnotiz (wer, was, wann)</label><input id={`${prefix}Text`} name="evidenceText" className="input" placeholder="mind. 10 Zeichen" /></div>
    </>
  );
}

export default async function BedarfPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let d;
  try {
    d = await getOpportunityDetail(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const { opp, ctx, canEdit } = d;
  const name = (uid: string | null | undefined) => (uid ? d.userNames.get(uid) ?? "?" : "–");
  const closed = opp.status === "BEENDET";
  const verlaufIdx = VERLAUF.indexOf(opp.status as (typeof VERLAUF)[number]);
  const md = opp.meddpicc ?? {};

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/kunden">Kunden</Link> › <Link href={`/kunden/${ctx.account.id}`}>{ctx.account.name}</Link> › <Link href={`/setups/${ctx.setup.id}`}>{ctx.setup.name}</Link> › Bedarf
      </p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{opp.title}</h1>
        <Status label={opportunityStatusLabel[opp.status] ?? opp.status} />
        {opp.fastTrack && <Status label="Direkte Anfrage (Fast-Track)" />}
        <span className="muted text-sm">Verantwortlich: {name(opp.ownerUserId)} · angelegt {fmtDateTime(opp.createdAt)}{opp.requestedAt && <> · Anfrage eingegangen {fmtDateTime(opp.requestedAt)}</>}</span>
        {!canEdit && <span className="muted text-sm">(nur lesend)</span>}
      </div>
      <Feedback params={sp} />

      {/* Kompakter Gesamtverlauf (9.1) – Zustände bleiben je Objekt getrennt */}
      <section className="card">
        <ol className="flex flex-wrap gap-2 text-sm">
          {VERLAUF.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span className={i <= verlaufIdx ? "font-semibold" : "muted"}>{opportunityStatusLabel[s]}</span>
              {i < VERLAUF.length - 1 && <span className="muted">→</span>}
            </li>
          ))}
          {(opp.status === "ZURUECKGESTELLT" || opp.status === "BEENDET") && <li className="muted">· {opportunityStatusLabel[opp.status]}{opp.statusReason && `: ${opp.statusReason}`}</li>}
        </ol>
        <p className="muted text-xs mt-1">Orientierung, keine Pflichtschleuse: Zugangsentwicklung läuft parallel weiter; Angebot, Auftrag und Einsatz haben eigene Zustände.</p>
      </section>

      {/* Bedarf */}
      <section className="card">
        <h2 className="font-semibold mb-2">Bedarf</h2>
        <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div className="sm:col-span-2"><dt className="muted">Bedarfsbeschreibung (Kundensprache)</dt><dd className="whitespace-pre-wrap">{opp.needDescription}</dd></div>
          <div><dt className="muted">Konkreter Anlass</dt><dd>{opp.trigger ?? "–"}</dd></div>
          <div><dt className="muted">Herkunft</dt><dd>{d.signal ? <>Hinweis: „{d.signal.observation}“</> : "direkt erfasst"}</dd></div>
          <div className="sm:col-span-2">
            <dt className="muted">Bestätigung</dt>
            <dd>
              {opp.confirmedAt ? (
                <>Bestätigt am {fmtDateTime(opp.confirmedAt)}{opp.confirmedSourceId && <> · <Link href={`/quellen/${opp.confirmedSourceId}`}>Quelle ansehen</Link></>}{opp.confirmedNote && <> · {opp.confirmedNote}</>}</>
              ) : <span className="muted">noch nicht bestätigt – eine Bestätigung braucht Quelle und Zeitpunkt</span>}
            </dd>
          </div>
        </dl>
        {canEdit && !closed && (
          <div className="mt-3 space-y-3">
            {(opp.status === "IN_KLAERUNG" || opp.status === "ZURUECKGESTELLT") && (
              <details>
                <summary>Bedarf bestätigen (mit Beleg)</summary>
                <form action={confirmOpportunityAction} className="mt-2 grid sm:grid-cols-2 gap-3">
                  <input type="hidden" name="opportunityId" value={opp.id} />
                  <input type="hidden" name="version" value={opp.version} />
                  <EvidenceFields prefix="conf" sources={d.sources} label="Bestätigung durch den Kunden" />
                  <div className="sm:col-span-2"><label className="label" htmlFor="confNote">Anmerkung (optional; Budget-/Beschaffungsinfo darf noch fehlen)</label><input id="confNote" name="confirmedNote" className="input" /></div>
                  <div className="sm:col-span-2"><button className="btn" type="submit">Bedarf bestätigen</button></div>
                </form>
              </details>
            )}
            <details>
              <summary>Bedarf bearbeiten</summary>
              <form action={updateOpportunityAction} className="mt-2 grid sm:grid-cols-2 gap-3">
                <input type="hidden" name="opportunityId" value={opp.id} />
                <input type="hidden" name="version" value={opp.version} />
                <div><label className="label" htmlFor="oTitle">Titel</label><input id="oTitle" name="title" className="input" required minLength={3} defaultValue={opp.title} /></div>
                <div>
                  <label className="label" htmlFor="oOwner">Verantwortlich</label>
                  <select id="oOwner" name="ownerUserId" className="select" defaultValue={opp.ownerUserId}>{d.users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
                </div>
                <div className="sm:col-span-2"><label className="label" htmlFor="oNeed">Bedarfsbeschreibung</label><textarea id="oNeed" name="needDescription" className="textarea" required minLength={10} defaultValue={opp.needDescription} /></div>
                <div className="sm:col-span-2"><label className="label" htmlFor="oTrigger">Konkreter Anlass</label><input id="oTrigger" name="trigger" className="input" defaultValue={opp.trigger ?? ""} /></div>
                <div className="sm:col-span-2"><button className="btn" type="submit">Speichern</button></div>
              </form>
            </details>
            <details>
              <summary>Zurückstellen / Beenden (mit Begründung)</summary>
              <form action={changeOpportunityStatusAction} className="mt-2 flex flex-wrap gap-2 items-end">
                <input type="hidden" name="opportunityId" value={opp.id} />
                <input type="hidden" name="version" value={opp.version} />
                <div><label className="label" htmlFor="oReason">Begründung</label><input id="oReason" name="reason" className="input" style={{ width: "24rem" }} required minLength={3} /></div>
                {opp.status !== "ZURUECKGESTELLT" && opp.status !== "BEAUFTRAGT" && <button className="btn btn-secondary" name="status" value="ZURUECKGESTELLT">Zurückstellen</button>}
                {opp.status === "ZURUECKGESTELLT" && <button className="btn btn-secondary" name="status" value="IN_KLAERUNG">Wieder in Klärung</button>}
                <button className="btn btn-secondary" name="status" value="BEENDET">Beenden</button>
              </form>
            </details>
          </div>
        )}
      </section>

      {/* Buyingcenter (8.3) */}
      <section className="card">
        <h2 className="font-semibold mb-2">Buyingcenter für diesen Bedarf ({d.participations.length})</h2>
        <p className="muted text-sm mb-2">Unbekannte Funktionen ohne erfundene Person anlegen. Eine Person kann mehrere Rollen haben. Ein Titel belegt keine Entscheidungsvollmacht.</p>
        {d.participations.length === 0 ? <p className="muted text-sm">Noch keine Rollen erfasst.</p> : (
          <table className="list">
            <thead><tr><th>Rolle</th><th>Person</th><th>Erkenntnisstatus</th><th>Anmerkung</th>{canEdit && <th></th>}</tr></thead>
            <tbody>
              {d.participations.map((p) => (
                <tr key={p.id}>
                  <td>{decisionRoleLabel[p.role] ?? p.role}</td>
                  <td>{p.personName ?? <span className="muted">Funktion bekannt, Person offen</span>}</td>
                  <td className="text-sm">{epistemicLabel[p.epistemicStatus] ?? p.epistemicStatus}{p.evidenceSourceId && <> · <Link href={`/quellen/${p.evidenceSourceId}`}>Quelle</Link></>}</td>
                  <td className="text-sm">{p.note ?? "–"}</td>
                  {canEdit && (
                    <td>
                      <form action={removeParticipationAction}><input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="participationId" value={p.id} /><button className="btn btn-secondary btn-small" type="submit">Entfernen</button></form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canEdit && !closed && (
          <details className="mt-3">
            <summary>Rolle hinzufügen</summary>
            <form action={addParticipationAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="opportunityId" value={opp.id} />
              <div>
                <label className="label" htmlFor="pRole">Rolle</label>
                <select id="pRole" name="role" className="select">{Object.entries(decisionRoleLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </div>
              <div>
                <label className="label" htmlFor="pPerson">Person (optional)</label>
                <select id="pPerson" name="personId" className="select" defaultValue=""><option value="">– Funktion bekannt, Person offen –</option>{d.persons.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select>
              </div>
              <div>
                <label className="label" htmlFor="pEpi">Erkenntnisstatus</label>
                <select id="pEpi" name="epistemicStatus" className="select" defaultValue="HYPOTHESE">
                  <option value="HYPOTHESE">{epistemicLabel.HYPOTHESE}</option>
                  <option value="AUSSAGE_WIEDERGEGEBEN">{epistemicLabel.AUSSAGE_WIEDERGEGEBEN}</option>
                  <option value="SACHVERHALT_BESTAETIGT">{epistemicLabel.SACHVERHALT_BESTAETIGT} (Quelle nötig)</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="pSource">Quelle</label>
                <select id="pSource" name="evidenceSourceId" className="select" defaultValue=""><option value="">–</option>{d.sources.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select>
              </div>
              <div className="sm:col-span-2"><label className="label" htmlFor="pNote">Anmerkung</label><input id="pNote" name="note" className="input" /></div>
              <div className="sm:col-span-2"><button className="btn" type="submit">Rolle speichern</button></div>
            </form>
          </details>
        )}
      </section>

      {/* MEDDPICC (9.4) */}
      <section className="card">
        <h2 className="font-semibold mb-2">Qualifizierungshilfe (MEDDPICC) – optional</h2>
        <p className="muted text-sm mb-2">Gezielte Hilfe bei Komplexität. Keine Pflicht vor einer Profilvorstellung, keine Bewertung, keine erfundenen Werte oder zugespitzter Leidensdruck.</p>
        {canEdit && !closed ? (
          <form action={saveMeddpiccAction} className="grid sm:grid-cols-2 gap-3">
            <input type="hidden" name="opportunityId" value={opp.id} />
            <input type="hidden" name="version" value={opp.version} />
            {MEDDPICC_KEYS.map(([k, label]) => (
              <div key={k}><label className="label" htmlFor={`md-${k}`}>{label}</label><input id={`md-${k}`} name={k} className="input" defaultValue={md[k] ?? ""} /></div>
            ))}
            <div className="sm:col-span-2"><button className="btn btn-secondary" type="submit">Speichern</button></div>
          </form>
        ) : (
          <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">{MEDDPICC_KEYS.map(([k, label]) => <div key={k}><dt className="muted">{label}</dt><dd>{md[k] ?? "–"}</dd></div>)}</dl>
        )}
      </section>

      {/* Angebote (F09, F10) */}
      <section className="card">
        <h2 className="font-semibold mb-2">Angebote / Profilvorstellungen ({d.offers.length})</h2>
        <p className="muted text-sm mb-2">„Tatsächlich vorgestellt“ setzt ein manuell bestätigtes Vorstellungsereignis mit Beleg voraus – ein Entwurf genügt nicht. Ein akzeptiertes Angebot ist noch kein Auftrag.</p>
        {d.offers.length === 0 ? <p className="muted text-sm">Noch kein Angebot.</p> : (
          <ul className="space-y-3">
            {d.offers.map((o) => {
              const refs = d.profileRefs.filter((r) => o.profileReferenceIds.includes(r.id));
              const final = o.status === "AKZEPTIERT" || o.status === "ABGELEHNT" || o.status === "ZURUECKGEZOGEN";
              return (
                <li key={o.id} className="border rounded-md p-3 text-sm" style={{ borderColor: "var(--border)" }}>
                  <div className="flex flex-wrap gap-2 items-baseline"><strong>{o.title}</strong><Status label={offerStatusLabel[o.status] ?? o.status} /><span className="muted">Fassung {o.versionNo} · {name(o.createdBy)} · {fmtDateTime(o.createdAt)}</span></div>
                  {o.summary && <p className="mt-1 whitespace-pre-wrap">{o.summary}</p>}
                  <p className="muted mt-1">Profilreferenzen: {refs.length ? refs.map((r) => r.label).join("; ") : "keine"}{o.artifactVersionId && <> · <Link href={`/artefakte/${o.artifactVersionId}`}>Kundentext</Link></>}</p>
                  {o.presentedAt && <p className="mt-1">Vorgestellt am {fmtDateTime(o.presentedAt)} an {o.presentedTo}{o.presentedSourceId && <> · <Link href={`/quellen/${o.presentedSourceId}`}>Beleg</Link></>}</p>}
                  {o.feedbackNote && <p className="mt-1">Rückmeldung: {o.feedbackNote}</p>}
                  {o.statusReason && <p className="muted mt-1">Grund: {o.statusReason}</p>}
                  {canEdit && !closed && !final && (
                    <div className="mt-2 space-y-2">
                      {o.status === "ENTWURF" && (
                        <form action={changeOfferStatusAction} className="flex gap-2">
                          <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="offerId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                          <button className="btn btn-small" name="status" value="GEPRUEFT">Als geprüft markieren</button>
                          <input name="note" className="input" style={{ width: "16rem" }} placeholder="Grund (bei Zurückziehen)" aria-label="Grund" />
                          <button className="btn btn-secondary btn-small" name="status" value="ZURUECKGEZOGEN">Zurückziehen</button>
                        </form>
                      )}
                      {o.status === "GEPRUEFT" && (
                        <details>
                          <summary>Vorstellungsereignis bestätigen</summary>
                          <form action={presentOfferAction} className="mt-2 grid sm:grid-cols-2 gap-3">
                            <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="offerId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                            <div><label className="label" htmlFor={`pt-${o.id}`}>Vorgestellt an (Personen/Funktionen)</label><input id={`pt-${o.id}`} name="presentedTo" className="input" required minLength={3} /></div>
                            <div><label className="label" htmlFor={`pa-${o.id}`}>Zeitpunkt</label><input id={`pa-${o.id}`} name="presentedAt" type="datetime-local" className="input" /></div>
                            <EvidenceFields prefix={`pres-${o.id}`} sources={d.sources} label="Versand-/Vorstellungsbeleg" />
                            <div className="sm:col-span-2"><button className="btn" type="submit">Als tatsächlich vorgestellt festhalten</button></div>
                          </form>
                        </details>
                      )}
                      {(o.status === "VORGESTELLT" || o.status === "RUECKMELDUNG_OFFEN") && (
                        <form action={changeOfferStatusAction} className="flex flex-wrap gap-2 items-end">
                          <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="offerId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                          <input name="note" className="input" style={{ width: "22rem" }} placeholder="Rückmeldung des Kunden / Grund" aria-label="Rückmeldung" />
                          {o.status === "VORGESTELLT" && <button className="btn btn-secondary btn-small" name="status" value="RUECKMELDUNG_OFFEN">Rückmeldung offen</button>}
                          <button className="btn btn-small" name="status" value="AKZEPTIERT">Akzeptiert</button>
                          <button className="btn btn-secondary btn-small" name="status" value="ABGELEHNT">Abgelehnt</button>
                          <button className="btn btn-secondary btn-small" name="status" value="ZURUECKGEZOGEN">Zurückgezogen</button>
                        </form>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && !closed && opp.status !== "BEAUFTRAGT" && (
          <details className="mt-3">
            <summary>Angebot anlegen (Entwurf)</summary>
            <form action={createOfferAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="opportunityId" value={opp.id} />
              <div className="sm:col-span-2"><label className="label" htmlFor="ofTitle">Titel</label><input id="ofTitle" name="title" className="input" required minLength={3} /></div>
              <div className="sm:col-span-2"><label className="label" htmlFor="ofSummary">Kurzinhalt (intern; Kundentext als Artefakt A9 Profilangebot)</label><textarea id="ofSummary" name="summary" className="textarea" rows={3} /></div>
              <fieldset className="sm:col-span-2">
                <legend className="label">Freigegebene Profilreferenzen</legend>
                {d.profileRefs.length === 0 ? <p className="muted text-sm">Keine Profilreferenzen vorhanden – anlegen unter <Link href="/einstellungen">Einstellungen</Link> (BD/Principal/CEO).</p> : (
                  <div className="flex flex-wrap gap-3 text-sm">{d.profileRefs.map((r) => <label key={r.id} className="flex items-center gap-1"><input type="checkbox" name="profileReferenceIds" value={r.id} /> {r.label}</label>)}</div>
                )}
              </fieldset>
              <div className="sm:col-span-2"><button className="btn" type="submit">Angebot anlegen</button></div>
            </form>
          </details>
        )}
      </section>

      {/* Aufträge und Startvoraussetzungen (9.3) */}
      <section className="card">
        <h2 className="font-semibold mb-2">Auftrag und Einsatz ({d.orders.length})</h2>
        <p className="muted text-sm mb-2">„Beauftragung bestätigt“ braucht prüfbare Bestell-/Vertragsnachweise. „Startbereit“ braucht den bestätigten Stand aller Startvoraussetzungen – eine leere Liste gilt nicht. „Gestartet“ ist ein bestätigtes Ereignis. Ohne freigegebene Regelkonfiguration wird hier nur der dokumentierte Stand gezeigt, keine produktive Einsatzfreigabe behauptet.</p>
        {d.orders.length === 0 ? <p className="muted text-sm">Noch kein Auftrag.</p> : (
          <ul className="space-y-3">
            {d.orders.map((o) => {
              const cancelled = o.status === "BEENDET_STORNIERT";
              const confirmed = o.status === "BEAUFTRAGUNG_BESTAETIGT";
              return (
                <li key={o.id} className="border rounded-md p-3 text-sm" style={{ borderColor: "var(--border)" }}>
                  <div className="flex flex-wrap gap-2 items-baseline"><strong>Auftrag {o.orderReference ?? "(Referenz offen)"}</strong><Status label={orderStatusLabel[o.status] ?? o.status} /><Status label={engagementStatusLabel[o.engagementStatus] ?? o.engagementStatus} /><span className="muted">geplant {fmtDate(o.plannedStart)} – {fmtDate(o.plannedEnd)}</span></div>
                  {o.confirmedAt && <p className="mt-1">Beauftragung bestätigt am {fmtDateTime(o.confirmedAt)} durch {name(o.confirmedBy)}{o.evidenceSourceId && <> · <Link href={`/quellen/${o.evidenceSourceId}`}>Nachweis</Link></>}{o.evidenceNote && <> · {o.evidenceNote}</>}</p>}
                  {o.startedAt && <p className="mt-1">Gestartet am {fmtDateTime(o.startedAt)}{o.statusReason && <> · {o.statusReason}</>}</p>}
                  {!o.startedAt && o.statusReason && <p className="muted mt-1">{o.statusReason}</p>}

                  <h3 className="font-semibold mt-3 mb-1">Startvoraussetzungen ({o.requirements.length})</h3>
                  {o.requirements.length === 0 ? <p className="muted">Keine erfasst – ohne erfasste und bestätigte Voraussetzungen keine Startfreigabe.</p> : (
                    <ul className="space-y-1">
                      {o.requirements.map((r) => (
                        <li key={r.id} className="flex flex-wrap gap-2 items-baseline">
                          <span>{r.requirement}</span><Status label={requirementStatusLabel[r.status] ?? r.status} />
                          <span className="muted">{r.checkedBy && `prüft: ${r.checkedBy}`}{r.policyRef && ` · Regel: ${r.policyRef}`}{r.evidenceSourceId && <> · <Link href={`/quellen/${r.evidenceSourceId}`}>Nachweis</Link></>}{r.evidenceNote && ` · ${r.evidenceNote}`}{r.confirmedAt && ` · bestätigt ${fmtDateTime(r.confirmedAt)} von ${name(r.confirmedBy)}`}</span>
                          {canEdit && !cancelled && o.engagementStatus !== "GESTARTET" && o.engagementStatus !== "BEENDET" && r.status !== "BESTAETIGT" && (
                            <details className="w-full">
                              <summary className="muted">Nachweis / Stand setzen</summary>
                              <form action={setRequirementStatusAction} className="mt-1 grid sm:grid-cols-2 gap-2">
                                <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="requirementId" value={r.id} /><input type="hidden" name="version" value={r.version} />
                                <div>
                                  <label className="label" htmlFor={`rs-${r.id}`}>Stand</label>
                                  <select id={`rs-${r.id}`} name="status" className="select" defaultValue="BESTAETIGT">
                                    <option value="NACHWEIS_VORGELEGT">Nachweis vorgelegt (Quelle nötig)</option>
                                    <option value="BESTAETIGT">Bestätigt (Quelle nötig)</option>
                                    <option value="NICHT_ANWENDBAR">Nicht anwendbar (Begründung nötig)</option>
                                  </select>
                                </div>
                                <div><label className="label" htmlFor={`rn-${r.id}`}>Anmerkung / Begründung</label><input id={`rn-${r.id}`} name="evidenceNote" className="input" /></div>
                                <EvidenceFields prefix={`req-${r.id}`} sources={d.sources} label="Nachweis" />
                                <div className="sm:col-span-2"><button className="btn btn-small" type="submit">Speichern</button></div>
                              </form>
                            </details>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {canEdit && !cancelled && (
                    <div className="mt-3 space-y-2">
                      {!confirmed && (
                        <details>
                          <summary>Beauftragung bestätigen (mit Nachweis)</summary>
                          <form action={confirmOrderAction} className="mt-2 grid sm:grid-cols-2 gap-3">
                            <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="orderId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                            <div><label className="label" htmlFor={`or-${o.id}`}>Bestell-/Vertragsreferenz</label><input id={`or-${o.id}`} name="orderReference" className="input" required minLength={2} defaultValue={o.orderReference ?? ""} /></div>
                            <div><label className="label" htmlFor={`on-${o.id}`}>Anmerkung</label><input id={`on-${o.id}`} name="evidenceNote" className="input" /></div>
                            <EvidenceFields prefix={`ord-${o.id}`} sources={d.sources} label="Bestell-/Vertragsnachweis" />
                            <div className="sm:col-span-2"><button className="btn" type="submit">Beauftragung bestätigen</button></div>
                          </form>
                        </details>
                      )}
                      {!confirmed && (
                        <form action={orderEvidenceIncompleteAction} className="flex flex-wrap gap-2 items-end">
                          <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="orderId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                          <input name="note" className="input" style={{ width: "22rem" }} placeholder="Welcher Nachweis fehlt?" aria-label="Fehlender Nachweis" />
                          <button className="btn btn-secondary btn-small" type="submit">Nachweise unvollständig</button>
                        </form>
                      )}
                      {o.engagementStatus !== "GESTARTET" && o.engagementStatus !== "BEENDET" && (
                        <details>
                          <summary>Startvoraussetzung erfassen</summary>
                          <form action={addStartRequirementAction} className="mt-2 grid sm:grid-cols-3 gap-3">
                            <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="orderId" value={o.id} />
                            <div><label className="label" htmlFor={`rq-${o.id}`}>Anforderung</label><input id={`rq-${o.id}`} name="requirement" className="input" required minLength={3} /></div>
                            <div><label className="label" htmlFor={`rc-${o.id}`}>Prüfende Stelle</label><input id={`rc-${o.id}`} name="checkedBy" className="input" /></div>
                            <div><label className="label" htmlFor={`rp-${o.id}`}>Regelbezug (falls freigegeben)</label><input id={`rp-${o.id}`} name="policyRef" className="input" /></div>
                            <div className="sm:col-span-3"><button className="btn btn-small" type="submit">Hinzufügen</button></div>
                          </form>
                        </details>
                      )}
                      {confirmed && o.engagementStatus === "GEPLANT" && (
                        <form action={markReadyAction}>
                          <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="orderId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                          <button className="btn" type="submit">Startbereit setzen (prüft alle Startvoraussetzungen)</button>
                        </form>
                      )}
                      {o.engagementStatus === "STARTBEREIT" && (
                        <form action={markStartedAction} className="flex flex-wrap gap-2 items-end">
                          <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="orderId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                          <div><label className="label" htmlFor={`sa-${o.id}`}>Startzeitpunkt</label><input id={`sa-${o.id}`} name="startedAt" type="datetime-local" className="input" /></div>
                          <div><label className="label" htmlFor={`sn-${o.id}`}>Bestätigung des Startereignisses</label><input id={`sn-${o.id}`} name="note" className="input" style={{ width: "22rem" }} required minLength={3} placeholder="z. B. Kick-off mit … durchgeführt" /></div>
                          <button className="btn" type="submit">Start bestätigen</button>
                        </form>
                      )}
                      <form action={cancelOrderAction} className="flex flex-wrap gap-2 items-end">
                        <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="orderId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                        <input name="reason" className="input" style={{ width: "22rem" }} placeholder="Grund" aria-label="Grund für Beenden/Stornieren" />
                        <button className="btn btn-secondary btn-small" type="submit">Auftrag beenden / stornieren</button>
                      </form>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && !closed && opp.status !== "ZURUECKGESTELLT" && (
          <details className="mt-3">
            <summary>Auftrag anlegen (in Vorbereitung)</summary>
            <form action={createOrderAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="opportunityId" value={opp.id} />
              <div>
                <label className="label" htmlFor="odOffer">Bezug auf Angebot (optional)</label>
                <select id="odOffer" name="offerId" className="select" defaultValue=""><option value="">–</option>{d.offers.map((o) => <option key={o.id} value={o.id}>{o.title} (Fassung {o.versionNo})</option>)}</select>
              </div>
              <div><label className="label" htmlFor="odRef">Bestell-/Vertragsreferenz (falls schon bekannt)</label><input id="odRef" name="orderReference" className="input" /></div>
              <div><label className="label" htmlFor="odStart">Geplanter Start</label><input id="odStart" name="plannedStart" type="date" className="input" /></div>
              <div><label className="label" htmlFor="odEnd">Geplantes Ende</label><input id="odEnd" name="plannedEnd" type="date" className="input" /></div>
              <div className="sm:col-span-2"><button className="btn" type="submit">Auftrag anlegen</button></div>
            </form>
          </details>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Passende Artefakte</h2>
        <p className="text-sm">Bedarfsklärung, Profilvorstellung und Auftrags-/Startunterlagen entstehen als Textentwürfe im Setup: <Link href={`/setups/${ctx.setup.id}/artefakte`}>Artefakte des Setups →</Link> (A7 Bedarfsbriefing, A8 Risiko-/Qualifizierungsnotiz, A9 Profilangebot, A10 Auswahl-/Entscheidungsstand, A11 Auftrags-/Startübergabe, A12 Verlängerung/Entwicklung). Kundentexte enthalten keine internen Einordnungen.</p>
      </section>
    </div>
  );
}
