import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { isSalesOpsOnly } from "@/modules/identity/actor";
import { DomainError } from "@/lib/errors";
import { getAccount } from "@/modules/accounts/service";
import { listSetupsForAccount } from "@/modules/setups/service";
import { renewalRoadmaps, canMaintainHealth, feedbackToneLabel, feedbackToneValues, getHealth, listingLabel, listingValues, listSnapshots, riskLabel, riskValues, ensureRecentSnapshot } from "@/modules/health/service";
import { HealthBadge } from "@/components/HealthBadge";
import { Feedback } from "@/components/Feedback";
import { fmtDate, fmtDateTime } from "@/lib/labels";
import { chanceKindLabel, chanceKindValues } from "@/modules/ai/schemas";
import { attachContractAction, recordExistingEngagementAction, saveHealthAnswerAction, setContractLinkAction, setOrderConsultantAction, updateOrderDatesAction } from "../../../actions";
import { db, schema } from "@/db/client";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Kunden-Health-Check (Etappe 23): geführtes Interview – eine Frage nach der anderen, nur was fehlt oder
 * älter als 90 Tage ist. Daneben der transparente Score mit Begründung je Dimension und der Verlauf.
 */
export default async function HealthPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fehler?: string; ok?: string; f?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let account;
  try {
    account = await getAccount(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const may = canMaintainHealth(actor, account);
  if (may) await ensureRecentSnapshot(actor, id); // Verlauf mindestens monatlich
  const [h, setups, snapshots] = await Promise.all([getHealth(actor, id), listSetupsForAccount(actor, id), listSnapshots(id)]);
  const back = `/kunden/${id}/health`;
  const idx = Math.min(Math.max(Number(sp.f ?? 0) || 0, 0), Math.max(h.questions.length - 1, 0));
  const q = h.questions[idx] ?? null;
  const canDecide = !isSalesOpsOnly(actor);
  const activeSetups = setups.filter((s) => s.status !== "ARCHIVIERT");
  const roadmaps = await renewalRoadmaps(h.engagements);
  const users = await db.query.users.findMany({ where: and(eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")), orderBy: (u, { asc }) => [asc(u.displayName)] });
  const setupIds = [...new Set(h.engagements.map((e) => e.setupId))];
  const ankers = setupIds.length ? await db.query.setupMemberships.findMany({ where: inArray(schema.setupMemberships.setupId, setupIds) }) : [];
  const isAnker = (setupId: string, userId: string | null) => !!userId && ankers.some((m) => m.setupId === setupId && m.userId === userId && m.contribution.startsWith("ANKER"));

  return (
    <div className="space-y-6">
      <p className="text-sm"><Link href="/kunden">Kunden</Link> › <Link href={`/kunden/${id}`}>{account.name}</Link> › Health-Check</p>
      <h1 className="text-2xl font-semibold">Health-Check: Wie sicher sitzen wir bei {account.name} im Sattel?</h1>
      <Feedback params={sp} />

      <section className="card">
        <HealthBadge score={h.score} level={h.level} coverage={h.coverage} size="large" />
        <p className="muted text-xs mt-2">Transparente Regeln statt KI-Schätzung: Jede Dimension hat feste Punkte mit Begründung. Unbekanntes zählt nicht in den Score, sondern senkt die Datenlage – unter 50 % Datenlage gibt es bewusst keinen Score. Bewertet wird der Kunde, nie eine Person.</p>
        <table className="list mt-3">
          <thead><tr><th>Dimension</th><th style={{ textAlign: "right" }}>Punkte</th><th>Begründung</th></tr></thead>
          <tbody>
            {h.dimensions.map((d) => (
              <tr key={d.key}>
                <td>{d.label}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{!d.known ? <span className="muted">unbekannt</span> : d.max > 0 ? `${d.points} / ${d.max}` : d.points < 0 ? d.points : "0"}</td>
                <td className="text-sm">{[...d.reasons, ...d.missing.map((m) => `Fehlt: ${m}`)].join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card" id="interview">
        <div className="flex flex-wrap items-baseline gap-3 mb-2">
          <h2 className="font-semibold">Interview</h2>
          <span className="muted text-sm">{h.questions.length === 0 ? "Alles aktuell – keine offenen Fragen." : `Frage ${idx + 1} von ${h.questions.length}`}</span>
        </div>
        {!may && <p className="muted text-sm">Den Health-Check pflegen BD, Principal, CEO oder Sales Operations.</p>}
        {q && may && (
          <div className="p-3" style={{ background: "var(--accent-soft)", borderRadius: 8 }}>
            <p className="font-medium">{q.text}</p>
            <p className="muted text-xs mb-3">Warum: {q.why}</p>

            {q.key === "ENGAGEMENT_END" && (() => {
              const e = h.engagements.find((x) => x.orderId === q.orderId)!;
              return (
                <>
                <p className="text-sm mb-2">{e.contractSourceId || e.evidenceSourceId || e.contractLink ? <>Nachschlagen: {(e.contractSourceId || e.evidenceSourceId) && <Link href={`/quellen/${e.contractSourceId ?? e.evidenceSourceId}`}>Vertrag/Bestellung ansehen</Link>}{e.contractLink && <> {(e.contractSourceId || e.evidenceSourceId) ? "· " : ""}{/^https?:\/\//.test(e.contractLink) ? <a href={e.contractLink} target="_blank" rel="noreferrer">im führenden System</a> : <span>liegt: {e.contractLink}</span>}</>}</> : <span className="muted">Kein Vertrag hinterlegt – unten bei „Einsätze“ hochladen oder verlinken. Unbekannt? „Später beantworten“ und den BD bzw. Sales Operations fragen.</span>}</p>
                <form action={updateOrderDatesAction} className="flex flex-wrap gap-3 items-end">
                  <input type="hidden" name="orderId" value={e.orderId} />
                  <input type="hidden" name="version" value={e.version} />
                  <input type="hidden" name="back" value={back} />
                  <div><label className="label" htmlFor="qEnd">Einsatzende</label><input id="qEnd" name="plannedEnd" type="date" className="input" required defaultValue={e.plannedEnd ?? ""} /></div>
                  <div><label className="label" htmlFor="qDl">Frist für Verlängerungsentscheidung (optional)</label><input id="qDl" name="renewalDeadline" type="date" className="input" defaultValue={e.renewalDeadline ?? ""} /></div>
                  <button className="btn" type="submit">Speichern</button>
                </form>
                </>
              );
            })()}

            {q.key === "ENGAGEMENT_MISSING" && (canDecide ? <ExistingEngagementForm accountId={id} setups={activeSetups} open /> : <p className="text-sm">Laufende Einsätze trägt der BD nach. Tipp: per „Unterstützung anfragen“ im Setup einen BD darum bitten.</p>)}

            {q.key === "FEEDBACK" && (
              <form action={saveHealthAnswerAction} className="grid sm:grid-cols-3 gap-3">
                <input type="hidden" name="accountId" value={id} />
                <input type="hidden" name="key" value="FEEDBACK" />
                <div>
                  <label className="label" htmlFor="qTone">Zufriedenheit</label>
                  <select id="qTone" name="tone" className="select" required defaultValue={h.answers.feedback?.tone ?? ""}>
                    <option value="" disabled>Bitte wählen …</option>
                    {feedbackToneValues.map((v) => <option key={v} value={v}>{feedbackToneLabel[v]}</option>)}
                  </select>
                </div>
                <div><label className="label" htmlFor="qFbDate">Wann war das letzte Feedback?</label><input id="qFbDate" name="date" type="date" className="input" defaultValue={h.answers.feedback?.date ?? ""} /></div>
                <div className="sm:col-span-3"><label className="label" htmlFor="qFbNote">Was wurde gesagt? (optional)</label><input id="qFbNote" name="note" className="input" maxLength={1000} defaultValue={h.answers.feedback?.note ?? ""} /></div>
                <div><button className="btn" type="submit">Speichern und weiter</button></div>
              </form>
            )}

            {q.key === "LISTING" && (
              <form action={saveHealthAnswerAction} className="grid sm:grid-cols-3 gap-3">
                <input type="hidden" name="accountId" value={id} />
                <input type="hidden" name="key" value="LISTING" />
                <div>
                  <label className="label" htmlFor="qList">Status</label>
                  <select id="qList" name="status" className="select" required defaultValue={h.answers.listing?.status ?? ""}>
                    <option value="" disabled>Bitte wählen …</option>
                    {listingValues.map((v) => <option key={v} value={v}>{listingLabel[v]}</option>)}
                  </select>
                </div>
                <div><label className="label" htmlFor="qValid">Gültig bis (optional)</label><input id="qValid" name="validUntil" type="date" className="input" defaultValue={h.answers.listing?.validUntil ?? ""} /></div>
                <div className="sm:col-span-3"><label className="label" htmlFor="qListNote">Notiz (z. B. Portal, Ansprechpartner Einkauf)</label><input id="qListNote" name="note" className="input" maxLength={1000} defaultValue={h.answers.listing?.note ?? ""} /></div>
                <div><button className="btn" type="submit">Speichern und weiter</button></div>
              </form>
            )}

            {q.key === "RISKS" && (
              <form action={saveHealthAnswerAction} className="space-y-2">
                <input type="hidden" name="accountId" value={id} />
                <input type="hidden" name="key" value="RISKS" />
                <div className="grid sm:grid-cols-2 gap-1 text-sm">
                  {riskValues.map((v) => (
                    <label key={v} className="flex items-center gap-2"><input type="checkbox" name="items" value={v} defaultChecked={h.answers.risks?.items.includes(v)} /> {riskLabel[v]}</label>
                  ))}
                </div>
                <div><label className="label" htmlFor="qRiskNote">Notiz (optional)</label><input id="qRiskNote" name="note" className="input" maxLength={1000} defaultValue={h.answers.risks?.note ?? ""} /></div>
                <button className="btn" type="submit">Speichern und weiter</button>
                <span className="muted text-xs ml-2">Nichts angekreuzt = „keine Risiken bekannt“ – das ist auch eine Antwort.</span>
              </form>
            )}

            {q.key === "PEOPLE" && (
              <p className="text-sm">Personen und Beziehungen werden je Setup gepflegt: {activeSetups.length ? activeSetups.map((s, i) => <span key={s.id}>{i > 0 && ", "}<Link href={`/setups/${s.id}/personen`}>{s.name}</Link></span>) : "zuerst ein Setup anlegen"}.</p>
            )}

            {h.questions.length > 1 && <p className="text-sm mt-3"><Link href={`${back}?f=${(idx + 1) % h.questions.length}#interview`}>Später beantworten – nächste Frage</Link></p>}
          </div>
        )}
        {h.questions.length > 1 && (
          <ol className="text-sm mt-3 list-decimal ml-5 space-y-0.5">
            {h.questions.map((x, i) => <li key={`${x.key}-${x.orderId ?? i}`}>{i === idx ? <strong>{x.text}</strong> : <Link href={`${back}?f=${i}#interview`}>{x.text}</Link>}</li>)}
          </ol>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Einsätze ({h.engagements.length})</h2>
        {h.engagements.length === 0 ? <p className="muted text-sm">Keine laufenden oder beauftragten Einsätze erfasst.</p> : (
          <table className="list">
            <thead><tr><th>Einsatz</th><th>Berater</th><th>Vertrag / Bestellung</th><th>Status</th><th>Start</th><th>Ende · Verlängerungsfrist</th><th>Verlängerung startet</th></tr></thead>
            <tbody>
              {h.engagements.map((e) => (
                <tr key={e.orderId}>
                  <td><Link href={`/bedarfe/${e.opportunityId}`}>{e.title}</Link><div className="muted text-xs">{e.setupName}</div></td>
                  <td className="text-sm">
                    {e.consultantName ?? <span className="muted">–</span>}
                    {isAnker(e.setupId, e.consultantUserId) && <div className="muted text-xs">zugleich Anker</div>}
                    {may && (
                      <details className="mt-1"><summary className="text-xs">ändern</summary>
                      <form action={setOrderConsultantAction} className="flex flex-wrap gap-1 mt-1">
                        <input type="hidden" name="orderId" value={e.orderId} />
                        <input type="hidden" name="version" value={e.version} />
                        <input type="hidden" name="back" value={back} />
                        <select name="consultantUserId" className="select" defaultValue={e.consultantUserId ?? ""} aria-label="Berater (Verve)" style={{ maxWidth: "9rem" }}>
                          <option value="">extern / Name</option>
                          {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                        </select>
                        <input name="consultantName" className="input" placeholder="Name" defaultValue={e.consultantUserId ? "" : e.consultantName ?? ""} aria-label="Name (z. B. Freelancer)" style={{ width: "7rem" }} />
                        <button className="btn btn-secondary btn-small" type="submit">OK</button>
                      </form>
                      </details>
                    )}
                  </td>
                  <td className="text-sm">
                    {(e.contractSourceId || e.evidenceSourceId) && <div><Link href={`/quellen/${e.contractSourceId ?? e.evidenceSourceId}`}>{e.contractSourceId ? "Vertrag ansehen" : "Nachweis ansehen"}</Link></div>}
                    {e.orderReference && <div className="muted text-xs">Ref. {e.orderReference}</div>}
                    {e.contractLink && <div className="text-xs">{/^https?:\/\//.test(e.contractLink) ? <a href={e.contractLink} target="_blank" rel="noreferrer">führendes System</a> : e.contractLink}</div>}
                    {!e.contractSourceId && !e.evidenceSourceId && !e.contractLink && <span className="muted">–</span>}
                    {may && (
                      <details className="mt-1">
                        <summary className="text-xs">hinterlegen</summary>
                        <form action={attachContractAction} className="flex flex-wrap gap-1 mt-1" encType="multipart/form-data">
                          <input type="hidden" name="orderId" value={e.orderId} />
                          <input type="hidden" name="back" value={back} />
                          <input type="file" name="file" className="text-xs" aria-label="Vertrag oder Bestellung hochladen" style={{ maxWidth: "12rem" }} />
                          <button className="btn btn-secondary btn-small" type="submit">Hochladen</button>
                        </form>
                        <form action={setContractLinkAction} className="flex flex-wrap gap-1 mt-1">
                          <input type="hidden" name="orderId" value={e.orderId} />
                          <input type="hidden" name="version" value={e.version} />
                          <input type="hidden" name="back" value={back} />
                          <input name="contractLink" className="input" placeholder="Link oder Ablageort" defaultValue={e.contractLink ?? ""} aria-label="Link oder Ablageort" style={{ width: "11rem" }} />
                          <button className="btn btn-secondary btn-small" type="submit">OK</button>
                        </form>
                      </details>
                    )}
                  </td>
                  <td className="text-sm">{e.status === "GESTARTET" ? "läuft" : "beauftragt"}{e.daysToEnd !== null && e.daysToEnd >= 0 ? ` · noch ${e.daysToEnd} Tage` : ""}</td>
                  <td className="text-sm">{fmtDate(e.plannedStart)}</td>
                  <td>
                    {may ? (
                      <form action={updateOrderDatesAction} className="flex flex-wrap gap-1 items-end">
                        <input type="hidden" name="orderId" value={e.orderId} />
                        <input type="hidden" name="version" value={e.version} />
                        <input type="hidden" name="back" value={back} />
                        <input name="plannedEnd" type="date" className="input" style={{ width: "10rem" }} defaultValue={e.plannedEnd ?? ""} aria-label="Einsatzende" />
                        <input name="renewalDeadline" type="date" className="input" style={{ width: "10rem" }} defaultValue={e.renewalDeadline ?? ""} aria-label="Verlängerungsfrist" />
                        <button className="btn btn-secondary btn-small" type="submit">Speichern</button>
                      </form>
                    ) : <span className="text-sm">{fmtDate(e.plannedEnd)} · {fmtDate(e.renewalDeadline)}</span>}
                  </td>
                  <td className="text-sm">{e.triggerDate ? fmtDate(e.triggerDate) : <span className="muted">Ende fehlt</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {[...roadmaps.entries()].filter(([oid]) => { const e = h.engagements.find((x) => x.orderId === oid); return e && e.daysToEnd !== null && e.daysToEnd <= 180; }).map(([oid, ms]) => {
          const e = h.engagements.find((x) => x.orderId === oid)!;
          const color: Record<string, string> = { ERLEDIGT: "#2f7d32", UEBERFAELLIG: "#c0392b", BALD: "#8a6d1f", SPAETER: "var(--muted)" };
          const label: Record<string, string> = { ERLEDIGT: "erledigt", UEBERFAELLIG: "überfällig", BALD: "steht an", SPAETER: "später" };
          return (
            <div key={oid} className="mt-4">
              <h3 className="text-sm font-semibold">Fahrplan Verlängerung – {e.title} <span className="muted font-normal">(endet {fmtDate(e.plannedEnd ?? e.renewalDeadline)}{e.daysToEnd !== null ? `, noch ${e.daysToEnd} Tage` : ""})</span></h3>
              <ol className="text-sm mt-1 space-y-1">
                {ms.map((m) => (
                  <li key={m.key} className="flex gap-2 items-baseline">
                    <span style={{ minWidth: "5.5rem" }} className="text-xs">{fmtDate(m.date)}</span>
                    <span className="status" style={{ color: color[m.state], borderColor: color[m.state], minWidth: "5.5rem", textAlign: "center" }}>{label[m.state]}</span>
                    <span>{m.label}</span>
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
        <p className="muted text-xs mt-2">Verlängerungsregel: 3 Monate vor Ende bekommt der BD einen Ping („Verlängerung ansprechen“). Am Auslösetag (Verlängerungsfrist − 14 Tage, sonst Einsatzende − 8 Wochen) startet automatisch „Verlängerung vor Einsatzende“ an der Chance; der erste Schritt kommt als Vorschlag zum BD. Vier Wochen vor Ende ohne Fortschritt erscheint der Einsatz bei Principal und CEO als Eskalation.</p>
        {canDecide && may && q?.key !== "ENGAGEMENT_MISSING" && <ExistingEngagementForm accountId={id} setups={activeSetups} />}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Verlauf</h2>
        {snapshots.length === 0 ? <p className="muted text-sm">Noch kein Stand gespeichert.</p> : (
          <ul className="text-sm space-y-1">{snapshots.map((s) => <li key={s.id}>{fmtDateTime(s.createdAt)}: <strong>{s.score ?? "–"}</strong> <span className="muted">· Datenlage {s.coverage} %</span></li>)}</ul>
        )}
        <p className="muted text-xs mt-2">Sinkt der Score um mehr als 10 Punkte, bekommt der zuständige BD eine Aufgabe vorgeschlagen.</p>
      </section>
    </div>
  );
}

function ExistingEngagementForm({ accountId, setups, open = false }: { accountId: string; setups: { id: string; name: string }[]; open?: boolean }) {
  if (setups.length === 0) return <p className="muted text-sm mt-2">Zum Nachtragen braucht der Kunde mindestens ein Setup.</p>;
  return (
    <details className="mt-3" open={open}>
      <summary className="text-sm">Laufenden Einsatz nachtragen (bisher nicht im Tool)</summary>
      <form action={recordExistingEngagementAction} className="mt-2 grid sm:grid-cols-3 gap-3">
        <input type="hidden" name="accountId" value={accountId} />
        <div><label className="label" htmlFor="eeSetup">Setup</label><select id="eeSetup" name="setupId" className="select" required defaultValue={setups[0]!.id}>{setups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div className="sm:col-span-2"><label className="label" htmlFor="eeTitle">Bezeichnung</label><input id="eeTitle" name="title" className="input" required minLength={3} placeholder="z. B. Testmanagement Kernbanksystem" /></div>
        <div><label className="label" htmlFor="eeKind">Art</label><select id="eeKind" name="kind" className="select" defaultValue="VERVE_EXPERTE">{chanceKindValues.map((k) => <option key={k} value={k}>{chanceKindLabel[k]}</option>)}</select></div>
        <div><label className="label" htmlFor="eeHc">Anzahl Personen</label><input id="eeHc" name="headcount" type="number" min={1} max={999} className="input" /></div>
        <div />
        <div><label className="label" htmlFor="eeStart">Start</label><input id="eeStart" name="plannedStart" type="date" className="input" /></div>
        <div><label className="label" htmlFor="eeEnd">Ende</label><input id="eeEnd" name="plannedEnd" type="date" className="input" /></div>
        <div><label className="label" htmlFor="eeDl">Verlängerungsfrist (optional)</label><input id="eeDl" name="renewalDeadline" type="date" className="input" /></div>
        <div className="sm:col-span-3"><label className="label" htmlFor="eeEv">Beleg (optional: Bestellnummer, Vertrag, seit wann)</label><input id="eeEv" name="evidenceText" className="input" /></div>
        <div className="sm:col-span-3"><label className="label" htmlFor="eeCons">Operativer Berater (optional)</label><input id="eeCons" name="consultantName" className="input" placeholder="Name – Verve-Kolleg:innen werden automatisch zugeordnet" /></div>
        <div><button className="btn" type="submit">Einsatz nachtragen</button></div>
      </form>
    </details>
  );
}
