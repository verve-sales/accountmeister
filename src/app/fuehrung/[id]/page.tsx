import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { hasRole } from "@/modules/identity/actor";
import { prepareLeadershipReview } from "@/modules/leadership/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { fmtDate, fmtDateTime, goalStatusLabel, reviewStatusLabel, reviewTypeLabel, supportStatusLabel } from "@/lib/labels";
import { addConfidentialNoteAction, addLeadershipDecisionAction, confirmLeadershipReviewAction, respondSupportRequestAction, saveLeadershipDraftAction } from "../../actions";

export default async function FuehrungsReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let p;
  try {
    p = await prepareLeadershipReview(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const { review } = p;
  const isLeader = hasRole(actor, "PRINCIPAL") || hasRole(actor, "CEO");
  const confirmed = review.status === "BESTAETIGT";
  const confirmedVersion = p.versions.find((v) => v.id === review.confirmedVersionId) ?? null;
  const back = `/fuehrung/${id}`;
  const isZielgespraech = review.type === "CEO_PRINCIPAL_ZIELGESPRAECH";

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/ziele">Ziele & Portfolio</Link> › {review.title}
      </p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{review.title}</h1>
        <Status label={reviewStatusLabel[review.status] ?? review.status} />
        <span className="muted text-sm">{reviewTypeLabel[review.type] ?? review.type} · {fmtDate(review.scheduledFor)} · Teilnehmende: {p.participants.map((x) => x.name).join(", ")}</span>
      </div>
      <Feedback params={sp} />

      {/* Vorbereitung */}
      <section className="card">
        <h2 className="font-semibold mb-2">Vorbereitung</h2>
        {p.last ? (
          <div className="text-sm space-y-1">
            <p>Letzter bestätigter Stand: <strong>{p.last.title}</strong> ({fmtDate(p.last.scheduledFor)}), bestätigt von {p.last.confirmedBy}.</p>
            {p.last.note && <details><summary className="text-sm">Notiz des letzten Reviews</summary><pre className="whitespace-pre-wrap text-sm mt-1" style={{ fontFamily: "inherit" }}>{p.last.note}</pre></details>}
            {p.last.decisions.length > 0 && <p className="muted">Damalige Entscheidungen: {p.last.decisions.join(" · ")}</p>}
          </div>
        ) : <p className="muted text-sm">Kein früheres bestätigtes Review dieser Art, an dem Sie teilgenommen haben.</p>}

        {p.portfolio && (
          <div className="mt-3">
            <h3 className="text-sm font-semibold mb-1">Portfolio – Zählungen aus den Accountplänen</h3>
            {p.portfolio.entries.length === 0 ? <p className="muted text-sm">Keine sichtbaren Kunden.</p> : (
              <table className="list text-sm">
                <thead><tr><th>Kunde</th><th>BD</th><th>Setups</th><th>Änderungen</th><th>Fragen</th><th>Zugangslücken</th><th>Blockiert</th><th>Unterstützung</th><th>Letztes Weekly</th></tr></thead>
                <tbody>
                  {p.portfolio.entries.map((e) => (
                    <tr key={e.accountId}>
                      <td><Link href={`/kunden/${e.accountId}`}>{e.accountName}</Link></td>
                      <td>{e.responsibleBd ?? "–"}</td>
                      <td>{e.setups}{e.setupsWithoutWeekly > 0 && <span className="muted"> ({e.setupsWithoutWeekly} ohne Weekly)</span>}</td>
                      <td>{e.openChanges}</td>
                      <td>{e.openQuestions}</td>
                      <td>{e.accessGaps}</td>
                      <td>{e.blockedActions}/{e.openActions}</td>
                      <td>{e.openSupport}</td>
                      <td>{e.lastConfirmedWeekly ? fmtDateTime(e.lastConfirmedWeekly) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted text-xs mt-1">{p.portfolio.note}</p>
          </div>
        )}

        <div className="mt-3">
          <h3 className="text-sm font-semibold mb-1">Offene Unterstützungsaufträge ({p.support.length})</h3>
          {p.support.length === 0 ? <p className="muted text-sm">Keine offenen Unterstützungsaufträge mit Ihrer Beteiligung.</p> : (
            <ul className="space-y-2">
              {p.support.map((s) => (
                <li key={s.id} className="border rounded-md p-3 text-sm" style={{ borderColor: "var(--border)" }}>
                  <div className="flex flex-wrap gap-2 items-baseline"><strong>{s.task}</strong><Status label={supportStatusLabel[s.status] ?? s.status} /><span className="muted">{s.requesterName} → {s.addresseeName}{s.setupName && <> · <Link href={`/setups/${s.setupId}`}>{s.setupName}</Link></>}{s.dueDate && ` · bis ${fmtDate(s.dueDate)}`}</span></div>
                  {s.context && <p className="muted mt-1">{s.context}</p>}
                  {!confirmed && (
                    <form action={respondSupportRequestAction} className="mt-2 flex flex-wrap gap-1 items-end">
                      <input type="hidden" name="requestId" value={s.id} />
                      <input type="hidden" name="version" value={s.version} />
                      <input type="hidden" name="back" value={back} />
                      <input name="note" className="input" style={{ width: "18rem" }} placeholder="Ergebnis / Begründung" aria-label="Ergebnis oder Begründung" />
                      {s.isAddressee && s.status === "ANGEFRAGT" && <button className="btn btn-small" name="decision" value="ANNEHMEN">Annehmen</button>}
                      {s.isAddressee && s.status === "ANGENOMMEN" && <button className="btn btn-small" name="decision" value="ERLEDIGEN">Ergebnis melden</button>}
                      {s.isAddressee && <button className="btn btn-secondary btn-small" name="decision" value="ZURUECKGEBEN">Zurückgeben</button>}
                      {s.isRequester && s.status === "ANGEFRAGT" && <button className="btn btn-secondary btn-small" name="decision" value="ZURUECKZIEHEN">Zurückziehen</button>}
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-3">
          <h3 className="text-sm font-semibold mb-1">Ziele ({p.goals.length})</h3>
          {p.goals.length === 0 ? <p className="muted text-sm">Keine Ziele sichtbar.{isZielgespraech && isLeader && <> Ziele werden unter <Link href="/ziele">Ziele & Portfolio</Link> angelegt und hier besprochen.</>}</p> : (
            <table className="list text-sm">
              <thead><tr><th>Ziel</th><th>Verantwortlich</th><th>Status</th><th>Vereinbart von</th><th>Beiträge</th></tr></thead>
              <tbody>
                {p.goals.map((g) => (
                  <tr key={g.id}>
                    <td><Link href={`/ziele/${g.id}`}>{g.title}</Link></td>
                    <td>{g.ownerName}</td>
                    <td><Status label={goalStatusLabel[g.status] ?? g.status} /></td>
                    <td>{g.agreedByNames.length > 0 ? g.agreedByNames.join(", ") : "–"}</td>
                    <td>{g.contributions.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Notiz */}
      <section className="card">
        <h2 className="font-semibold mb-2">Notiz {confirmed ? "(bestätigte Fassung)" : "(Entwurf)"}</h2>
        {confirmed ? (
          <pre className="whitespace-pre-wrap text-sm" style={{ fontFamily: "inherit" }}>{confirmedVersion?.note || review.noteDraft || "–"}</pre>
        ) : (
          <form action={saveLeadershipDraftAction} className="space-y-2">
            <input type="hidden" name="reviewId" value={review.id} />
            <input type="hidden" name="version" value={review.version} />
            <label className="label" htmlFor="lNote">Gemeinsame Notiz – sichtbar für alle Teilnehmenden</label>
            <textarea id="lNote" name="noteDraft" className="textarea" rows={8} defaultValue={review.noteDraft ?? ""} />
            <button className="btn" type="submit">Entwurf speichern</button>
          </form>
        )}
      </section>

      {/* Entscheidungen */}
      <section className="card">
        <h2 className="font-semibold mb-2">Entscheidungen ({p.decisions.length})</h2>
        {p.decisions.length === 0 ? <p className="muted text-sm">Noch keine Entscheidungen festgehalten.</p> : (
          <ul className="text-sm space-y-1">
            {p.decisions.map((d) => (
              <li key={d.id}><strong>{d.content}</strong>{d.scope && <> · Geltung: {d.scope}</>}{d.rationale && <> · Begründung: {d.rationale}</>}<span className="muted"> · {d.decidedByUserIds.map((u) => p.userNames.get(u) ?? "?").join(", ")} · {fmtDate(d.decidedOn)}</span></li>
            ))}
          </ul>
        )}
        {!confirmed && (
          <details className="mt-3">
            <summary>Entscheidung festhalten</summary>
            <form action={addLeadershipDecisionAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="reviewId" value={review.id} />
              <div className="sm:col-span-2"><label className="label" htmlFor="dContent">Entscheidung</label><input id="dContent" name="content" className="input" required minLength={5} /></div>
              <div><label className="label" htmlFor="dScope">Geltungsbereich</label><input id="dScope" name="scope" className="input" /></div>
              <div><label className="label" htmlFor="dRationale">Begründung</label><input id="dRationale" name="rationale" className="input" /></div>
              <div className="sm:col-span-2"><button className="btn" type="submit">Entscheidung speichern</button></div>
            </form>
          </details>
        )}
      </section>

      {/* Vertrauliche Notizen – nur für Führungsrollen, expliziter Empfängerkreis */}
      {isLeader && (
        <section className="card">
          <h2 className="font-semibold mb-2">Vertrauliche Notizen ({p.confidential.length})</h2>
          <p className="muted text-sm mb-2">Sichtbar nur für den gewählten Empfängerkreis. Erscheint nie im Setup, im Accountplan oder im KI-Kontext (Briefing 11.4).</p>
          {p.confidential.length === 0 ? <p className="muted text-sm">Keine vertraulichen Notizen für Sie in diesem Review.</p> : (
            <ul className="text-sm space-y-2">
              {p.confidential.map((n) => (
                <li key={n.id} className="border rounded-md p-3" style={{ borderColor: "var(--border)" }}>
                  <p className="whitespace-pre-wrap">{n.body}</p>
                  <p className="muted mt-1">{n.aboutUserId && <>Zu: {p.userNames.get(n.aboutUserId) ?? "?"} · </>}Empfängerkreis: {n.audienceUserIds.map((u) => p.userNames.get(u) ?? "?").join(", ")} · {p.userNames.get(n.createdBy) ?? "?"} · {fmtDateTime(n.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
          <details className="mt-3">
            <summary>Vertrauliche Notiz hinzufügen</summary>
            <form action={addConfidentialNoteAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="reviewId" value={review.id} />
              <div className="sm:col-span-2"><label className="label" htmlFor="cnBody">Notiz</label><textarea id="cnBody" name="body" className="textarea" required minLength={3} rows={4} /></div>
              <div>
                <label className="label" htmlFor="cnAbout">Bezieht sich auf (optional)</label>
                <select id="cnAbout" name="aboutUserId" className="select" defaultValue=""><option value="">–</option>{p.participants.filter((x) => x.userId !== actor.userId).map((x) => <option key={x.userId} value={x.userId}>{x.name}</option>)}</select>
              </div>
              <fieldset>
                <legend className="label">Empfängerkreis (zusätzlich zu Ihnen; nur Teilnehmende)</legend>
                <div className="flex flex-wrap gap-3 text-sm">{p.participants.filter((x) => x.userId !== actor.userId).map((x) => <label key={x.userId} className="flex items-center gap-1"><input type="checkbox" name="audienceUserIds" value={x.userId} /> {x.name}</label>)}</div>
              </fieldset>
              <div className="sm:col-span-2"><button className="btn" type="submit">Vertraulich speichern</button></div>
            </form>
          </details>
        </section>
      )}

      {/* Bestätigung */}
      <section className="card">
        <h2 className="font-semibold mb-2">Bestätigung</h2>
        {confirmed && confirmedVersion ? (
          <p className="text-sm">Bestätigt von {p.userNames.get(confirmedVersion.confirmedBy) ?? "?"} am {fmtDateTime(confirmedVersion.confirmedAt)} (Version {confirmedVersion.versionNo}). Bestätigte Reviews werden nicht überschrieben.</p>
        ) : (
          <form action={confirmLeadershipReviewAction} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="reviewId" value={review.id} />
            <input type="hidden" name="version" value={review.version} />
            <button className="btn" type="submit" disabled={review.status === "GEPLANT"}>Review bestätigen</button>
            {review.status === "GEPLANT" && <span className="muted text-sm">Bitte zuerst die Notiz als Entwurf speichern.</span>}
          </form>
        )}
      </section>
    </div>
  );
}
