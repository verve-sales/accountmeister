import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { prepareReview } from "@/modules/reviews/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { actionStatusLabel, fmtDate, fmtDateTime, handoverStatusLabel, reviewStatusLabel, signalStatusLabel } from "@/lib/labels";
import { addDecisionAction, captureObservationAction, confirmReviewAction, correctReviewAction, createActionAction, saveReviewDraftAction } from "../../actions";

export default async function WeeklyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let p;
  try {
    p = await prepareReview(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const { review, ctx } = p;
  const name = (uid: string | null | undefined) => (uid ? p.userNames.get(uid) ?? "?" : "–");
  const users = await db.query.users.findMany({ where: eq(schema.users.status, "ACTIVE"), orderBy: (u, { asc }) => [asc(u.displayName)] });
  const back = `/weeklys/${id}`;
  const confirmed = review.status === "BESTAETIGT";
  const inProgress = review.status === "LAUFEND" || review.status === "BESTAETIGUNG_OFFEN";
  const canCapture = p.canWork && p.canEditSetup && !confirmed;
  const currentVersion = p.versions.find((v) => v.id === review.confirmedVersionId) ?? null;

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/weeklys">Weeklys</Link> › <Link href={`/setups/${ctx.setup.id}`}>{ctx.setup.name}</Link> › {review.title}
      </p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{review.title}</h1>
        <Status label={reviewStatusLabel[review.status] ?? review.status} />
        <span className="muted text-sm">{fmtDate(review.scheduledFor)} · Teilnehmende: {p.participants.map((x) => x.name).join(", ")}</span>
        {!p.canWork && <span className="muted text-sm">(nur lesend)</span>}
      </div>
      <Feedback params={sp} />

      {/* Vorbereitung */}
      <section className="card">
        <h2 className="font-semibold mb-2">Vorbereitung – Stand seit dem letzten bestätigten Weekly</h2>
        {p.lastConfirmed ? (
          <div className="text-sm space-y-1">
            <p>Letzter bestätigter Stand: <strong>{p.lastConfirmed.reviewTitle}</strong> ({fmtDate(p.lastConfirmed.scheduledFor)}), bestätigt von {p.lastConfirmed.confirmedBy} am {fmtDateTime(p.lastConfirmed.confirmedAt)}.</p>
            {p.lastConfirmed.note && <details><summary className="text-sm">Notiz des letzten Weeklys</summary><pre className="whitespace-pre-wrap text-sm mt-1" style={{ fontFamily: "inherit" }}>{p.lastConfirmed.note}</pre></details>}
            <p className="muted">Damals offen: {p.lastConfirmed.snapshot.openSignalCount} Hinweise, {p.lastConfirmed.snapshot.openActionCount} Aktionen, {p.lastConfirmed.snapshot.openHandoverCount} Übergaben.</p>
          </div>
        ) : (
          <p className="muted text-sm">Noch kein bestätigtes Weekly für dieses Setup – dies ist der erste dokumentierte Stand.</p>
        )}
        <div className="grid md:grid-cols-2 gap-4 mt-3 text-sm">
          <div>
            <h3 className="font-medium">Neue Beobachtungen seitdem ({p.newSignals.length})</h3>
            {p.newSignals.length === 0 ? <p className="muted">keine</p> : <ul className="list-disc ml-5">{p.newSignals.map((s) => <li key={s.id}><Status label={signalStatusLabel[s.status] ?? s.status} /> {s.observation} <span className="muted">({name(s.createdBy)}, {fmtDate(s.createdAt)})</span></li>)}</ul>}
          </div>
          <div>
            <h3 className="font-medium">Offene Übergaben ({p.openHandovers.length})</h3>
            {p.openHandovers.length === 0 ? <p className="muted">keine</p> : <ul className="list-disc ml-5">{p.openHandovers.map((h) => <li key={h.id}>{h.responsibility} – {name(h.senderUserId)} → {name(h.receiverUserId)} <Status label={handoverStatusLabel[h.status] ?? h.status} /></li>)}</ul>}
          </div>
          <div>
            <h3 className="font-medium">Vereinbarte Aktionen, Stand heute ({p.openActions.length} offen)</h3>
            {p.openActions.length === 0 ? <p className="muted">keine offenen Aktionen</p> : <ul className="list-disc ml-5">{p.openActions.map((a) => <li key={a.id}>{a.title} – {name(a.ownerUserId)} <Status label={actionStatusLabel[a.status] ?? a.status} /> {a.dueDate && <span className="muted">bis {fmtDate(a.dueDate)}</span>}</li>)}</ul>}
          </div>
          <div>
            <h3 className="font-medium">Seitdem veränderte Aktionen ({p.changedActions.length})</h3>
            {p.changedActions.length === 0 ? <p className="muted">keine</p> : <ul className="list-disc ml-5">{p.changedActions.map((a) => <li key={a.id}>{a.title} → <Status label={actionStatusLabel[a.status] ?? a.status} />{a.result && <span className="muted"> – {a.result}</span>}</li>)}</ul>}
          </div>
        </div>
        <p className="muted text-sm mt-3">Vorschläge: KI-Anbieter deaktiviert – keine automatische Agenda.</p>
      </section>

      {/* Durchführung */}
      <section className="card">
        <h2 className="font-semibold mb-2">Gespräch – gemeinsame Notiz</h2>
        {confirmed ? (
          <pre className="whitespace-pre-wrap text-sm" style={{ fontFamily: "inherit" }}>{currentVersion?.note ?? review.noteDraft ?? "(keine Notiz)"}</pre>
        ) : p.canWork ? (
          <form action={saveReviewDraftAction} className="space-y-2">
            <input type="hidden" name="reviewId" value={review.id} />
            <input type="hidden" name="version" value={review.version} />
            <label className="label" htmlFor="noteDraft">Freitextnotiz (wird nur als Entwurf gespeichert; Strukturierung erfolgt manuell über die Felder unten)</label>
            <textarea id="noteDraft" name="noteDraft" className="textarea" style={{ minHeight: "10rem" }} defaultValue={review.noteDraft ?? ""} />
            <div className="flex gap-2">
              <button className="btn btn-secondary" type="submit" name="toStatus" value="LAUFEND">Entwurf speichern</button>
              {inProgress && <button className="btn" type="submit" name="toStatus" value="BESTAETIGUNG_OFFEN">Speichern und zur Ergebnisvorschau</button>}
            </div>
          </form>
        ) : (
          <pre className="whitespace-pre-wrap text-sm muted" style={{ fontFamily: "inherit" }}>{review.noteDraft ?? "(noch keine Notiz)"}</pre>
        )}
      </section>

      {/* Ergebnisvorschau */}
      <section className="card">
        <h2 className="font-semibold mb-2">Ergebnisvorschau – was in diesem Weekly festgehalten wurde</h2>
        <div className="grid md:grid-cols-3 gap-4 text-sm">
          <div>
            <h3 className="font-medium">Neue Beobachtungen ({p.inThisReview.signals.length})</h3>
            {p.inThisReview.signals.length === 0 ? <p className="muted">keine</p> : <ul className="list-disc ml-5">{p.inThisReview.signals.map((s) => <li key={s.id}>{s.observation}{s.relevanceHypothesis && <div className="muted">Vermutung: {s.relevanceHypothesis}</div>}</li>)}</ul>}
          </div>
          <div>
            <h3 className="font-medium">Aktionen ({p.inThisReview.actions.length})</h3>
            {p.inThisReview.actions.length === 0 ? <p className="muted">keine</p> : <ul className="list-disc ml-5">{p.inThisReview.actions.map((a) => <li key={a.id}>{a.title} – {name(a.ownerUserId)} <Status label={actionStatusLabel[a.status] ?? a.status} />{a.status === "VORGESCHLAGEN" && <span className="muted"> (Idee, noch nicht angenommen)</span>}</li>)}</ul>}
          </div>
          <div>
            <h3 className="font-medium">Entscheidungen ({p.inThisReview.decisions.length})</h3>
            {p.inThisReview.decisions.length === 0 ? <p className="muted">keine</p> : <ul className="list-disc ml-5">{p.inThisReview.decisions.map((d) => <li key={d.id}>{d.content}{d.rationale && <div className="muted">Begründung: {d.rationale}</div>}</li>)}</ul>}
          </div>
        </div>

        {canCapture && (
          <div className="grid lg:grid-cols-3 gap-6 mt-4">
            <details>
              <summary className="text-sm">Beobachtung festhalten</summary>
              <form action={captureObservationAction} className="mt-2 space-y-2">
                <input type="hidden" name="setupId" value={ctx.setup.id} />
                <input type="hidden" name="reviewId" value={review.id} />
                <input type="hidden" name="sourceTitle" value={`Weekly-Notiz ${review.title}`} />
                <div><label className="label" htmlFor="obs">Sichere Beobachtung</label><textarea id="obs" name="observation" className="textarea" required minLength={5} /></div>
                <div><label className="label" htmlFor="hyp">Vermutung (getrennt)</label><input id="hyp" name="relevanceHypothesis" className="input" /></div>
                <div><label className="label" htmlFor="lim">Nutzungsgrenze</label><input id="lim" name="usageLimit" className="input" /></div>
                <button className="btn btn-small" type="submit">Beobachtung speichern</button>
              </form>
            </details>
            <details>
              <summary className="text-sm">Aktion festhalten</summary>
              <form action={createActionAction} className="mt-2 space-y-2">
                <input type="hidden" name="setupId" value={ctx.setup.id} />
                <input type="hidden" name="reviewId" value={review.id} />
                <input type="hidden" name="back" value={back} />
                <div><label className="label" htmlFor="actT">Was wird getan?</label><input id="actT" name="title" className="input" required minLength={3} /></div>
                <div>
                  <label className="label" htmlFor="actO">Wer übernimmt?</label>
                  <select id="actO" name="ownerUserId" className="select" defaultValue={actor.userId}>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
                </div>
                <div><label className="label" htmlFor="actD">Termin</label><input id="actD" name="dueDate" type="date" className="input" /></div>
                <label className="text-sm flex items-center gap-2"><input type="checkbox" name="agreedInConversation" value="true" /> Gemeinsam vereinbart (sonst bleibt es eine Idee)</label>
                <button className="btn btn-small" type="submit">Aktion speichern</button>
              </form>
            </details>
            <details>
              <summary className="text-sm">Entscheidung festhalten</summary>
              <form action={addDecisionAction} className="mt-2 space-y-2">
                <input type="hidden" name="reviewId" value={review.id} />
                <div><label className="label" htmlFor="decC">Entscheidung</label><textarea id="decC" name="content" className="textarea" required minLength={5} /></div>
                <div><label className="label" htmlFor="decS">Geltungsbereich</label><input id="decS" name="scope" className="input" /></div>
                <div><label className="label" htmlFor="decR">Begründung</label><input id="decR" name="rationale" className="input" /></div>
                <button className="btn btn-small" type="submit">Entscheidung speichern</button>
              </form>
            </details>
          </div>
        )}
      </section>

      {/* Bestätigung / Versionen */}
      <section className="card">
        <h2 className="font-semibold mb-2">Bestätigung</h2>
        {confirmed && currentVersion ? (
          <div className="text-sm space-y-2">
            <p>
              Bestätigt von <strong>{name(currentVersion.confirmedBy)}</strong> am {fmtDateTime(currentVersion.confirmedAt)} · Version {currentVersion.versionNo}
              {currentVersion.correctionNote && <span className="muted"> · Korrektur: {currentVersion.correctionNote}</span>}
            </p>
            <p className="muted">Die Bestätigung dokumentiert den Stand durch diese Person; sie ist kein Einverständnis aller Beteiligten.</p>
            {p.versions.length > 1 && (
              <details><summary>Versionsverlauf ({p.versions.length})</summary>
                <ul className="mt-1 space-y-1">{p.versions.map((v) => <li key={v.id}>Version {v.versionNo} – {name(v.confirmedBy)}, {fmtDateTime(v.confirmedAt)}{v.correctionNote && <span className="muted"> – {v.correctionNote}</span>}{v.note && <details><summary className="muted">Notiz</summary><pre className="whitespace-pre-wrap" style={{ fontFamily: "inherit" }}>{v.note}</pre></details>}</li>)}</ul>
              </details>
            )}
            {p.isParticipant && (
              <details><summary>Korrekturversion anlegen</summary>
                <form action={correctReviewAction} className="mt-2 space-y-2">
                  <input type="hidden" name="reviewId" value={review.id} />
                  <input type="hidden" name="version" value={review.version} />
                  <div><label className="label" htmlFor="corrNote">Korrigierte Notiz</label><textarea id="corrNote" name="note" className="textarea" defaultValue={currentVersion.note ?? ""} /></div>
                  <div><label className="label" htmlFor="corrWhy">Grund der Korrektur (Pflicht)</label><input id="corrWhy" name="correctionNote" className="input" required minLength={5} /></div>
                  <button className="btn btn-secondary btn-small" type="submit">Korrekturversion speichern</button>
                </form>
              </details>
            )}
          </div>
        ) : p.isParticipant ? (
          <form action={confirmReviewAction} className="space-y-2">
            <input type="hidden" name="reviewId" value={review.id} />
            <input type="hidden" name="version" value={review.version} />
            <p className="text-sm muted">Mit der Bestätigung wird der oben gezeigte Stand (Notiz, Beobachtungen, Aktionen, Entscheidungen, offene Punkte) als Version 1 festgeschrieben. Ideen bleiben Vorschläge, bis die verantwortliche Person sie annimmt.</p>
            <button className="btn" type="submit" disabled={!inProgress}>Stand bestätigen</button>
            {!inProgress && <p className="muted text-sm">Bitte zuerst die Notiz speichern (Weekly durchführen).</p>}
          </form>
        ) : (
          <p className="muted text-sm">Nur Teilnehmende bestätigen den Stand.</p>
        )}
      </section>
    </div>
  );
}
