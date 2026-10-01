import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { DomainError } from "@/lib/errors";
import { getWorkItemDetail, workKindLabel, workStatusLabel, workTargets } from "@/modules/work/service";
import { subjectTypeLabel } from "@/modules/work/subjects";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Comments, SlaBadge, WorkList } from "@/components/Work";
import { WorkCreateForm } from "@/components/WorkCreateForm";
import { fmtDate, fmtDateTime } from "@/lib/labels";
import { reassignWorkItemAction, toggleChecklistAction, updateWorkItemAction, watchWorkItemAction, workItemAction } from "../../actions";

const ACTION_TEXT: Record<string, string> = {
  "work.created": "angelegt",
  "work.status_changed": "Status geändert",
  "work.reassigned": "umverteilt",
  "work.updated": "Frist/Priorität geändert",
  "comment.created": "kommentiert",
  "comment.edited": "Kommentar bearbeitet",
  "comment.deleted": "Kommentar gelöscht",
};

type BtnProps = { id: string; version: number; back: string; resultPlaceholder: string; action: string; label: string; secondary?: boolean; note?: boolean; noteLabel?: string; result?: boolean };

function Btn({ id, version, back, resultPlaceholder, action, label, secondary, note, noteLabel, result }: BtnProps) {
  return (
    <form action={workItemAction} className="flex flex-wrap gap-2 items-end">
      <input type="hidden" name="workItemId" value={id} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="action" value={action} />
      {note && <input name="note" className="input" placeholder={noteLabel} style={{ minWidth: 260 }} aria-label={noteLabel} />}
      {result && <textarea name="result" className="input" rows={2} placeholder={resultPlaceholder} style={{ minWidth: 320 }} aria-label="Ergebnis" />}
      <button className={`btn btn-small${secondary ? " btn-secondary" : ""}`} type="submit">
        {label}
      </button>
    </form>
  );
}

export default async function VorgangPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let d;
  try {
    d = await getWorkItemDetail(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const { item: w, roles: r } = d;
  const back = `/vorgaenge/${w.id}`;
  const final = w.status === "ERLEDIGT" || w.status === "VERWORFEN";
  const worker = r.assignee || (!w.assigneeUserId && r.teamMember);
  const targets = await workTargets(actor);
  const checklist = (w.checklist as { text: string; done: boolean }[]) ?? [];
  const fieldValues = w.fields as Record<string, string>;

  const resultPlaceholder = w.reviewRequired && !r.requester ? "Ergebnis (geht zur Prüfung an die Auftraggeber:in)" : "Ergebnis (optional)";

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm">
          <Link href="/meine-arbeit">Meine Arbeit</Link>
          {d.subject?.link && (
            <>
              {" · "}
              <Link href={d.subject.link}>{d.subject.label}</Link>
            </>
          )}
          {d.parent && (
            <>
              {" · Teil von "}
              <Link href={`/vorgaenge/${d.parent.id}`}>{d.parent.title}</Link>
            </>
          )}
        </p>
        <h1 className="text-2xl font-semibold mt-1">{w.title}</h1>
        <div className="flex flex-wrap gap-2 items-baseline mt-1">
          <span className="status">{workStatusLabel[w.status] ?? w.status}</span>
          <span className="muted text-sm">{workKindLabel[w.kind] ?? w.kind}{w.serviceName ? ` · ${w.serviceName}` : ""}</span>
          {w.priority === "HOCH" && <span className="text-sm" style={{ color: "#b7791f", fontWeight: 600 }}>dringend</span>}
          <SlaBadge state={w.slaState} />
        </div>
      </div>
      <Feedback params={sp} />

      <section className="card">
        <dl className="text-sm grid sm:grid-cols-3 gap-x-6 gap-y-2">
          <div><dt className="muted">Auftraggeber:in</dt><dd>{w.requesterName}</dd></div>
          <div><dt className="muted">Bearbeitet von</dt><dd>{w.assigneeName ?? (w.teamName ? `${w.teamName} – noch nicht übernommen` : "–")}{w.deputyForName ? ` (Vertretung für ${w.deputyForName})` : ""}</dd></div>
          <div><dt className="muted">Bezug</dt><dd>{d.subject?.link ? <Link href={d.subject.link}>{d.subject.label}</Link> : subjectTypeLabel[w.subjectType] ?? "–"}</dd></div>
          <div><dt className="muted">Frist</dt><dd style={w.overdue ? { color: "#c0392b", fontWeight: 600 } : undefined}>{fmtDate(w.dueDate)}{w.overdue ? " (überfällig)" : ""}</dd></div>
          {w.slaDueDate && <div><dt className="muted">Zusage Team (SLA)</dt><dd>{fmtDate(w.slaDueDate)}</dd></div>}
          <div><dt className="muted">Ergebnis prüfen</dt><dd>{w.reviewRequired ? "ja, vor Abschluss durch Auftraggeber:in" : "nein"}</dd></div>
          {d.blockedBy && <div><dt className="muted">Wartet auf</dt><dd><Link href={`/vorgaenge/${d.blockedBy.id}`}>{d.blockedBy.title}</Link> ({workStatusLabel[d.blockedBy.status]})</dd></div>}
        </dl>
        {w.description && <p className="text-sm mt-3" style={{ whiteSpace: "pre-wrap" }}>{w.description}</p>}
        {d.serviceFields.length > 0 && (
          <dl className="text-sm grid sm:grid-cols-2 gap-x-6 gap-y-1 mt-3">
            {d.serviceFields.map((f) => (
              <div key={f.key}><dt className="muted">{f.label}</dt><dd>{fieldValues[f.key] ?? "–"}</dd></div>
            ))}
          </dl>
        )}
        {w.statusNote && <p className="text-sm mt-3"><span className="muted">Hinweis zum Status:</span> {w.statusNote}</p>}
        {w.result && <p className="text-sm mt-2" style={{ whiteSpace: "pre-wrap" }}><span className="muted">Ergebnis:</span> {w.result}</p>}
      </section>

      {!final && (
        <section className="card space-y-3">
          <h2 className="font-semibold">Nächster Schritt</h2>
          {w.status === "ANGEFRAGT" && (r.assignee || (!w.assigneeUserId && (r.teamMember || r.teamLead))) && (
            <div className="flex flex-wrap gap-3 items-end">
              <Btn id={w.id} version={w.version} back={back} resultPlaceholder={resultPlaceholder} action="ANNEHMEN" label={w.assigneeUserId ? "Annehmen" : "Übernehmen"} />
              <Btn id={w.id} version={w.version} back={back} resultPlaceholder={resultPlaceholder} action="ABLEHNEN" label="Ablehnen" secondary note noteLabel="Warum nicht? (Pflicht)" />
            </div>
          )}
          {w.status === "ANGEFRAGT" && !(r.assignee || (!w.assigneeUserId && (r.teamMember || r.teamLead))) && <p className="text-sm muted">Wartet auf Annahme durch {w.assigneeName ?? w.teamName}.</p>}
          {["OFFEN", "IN_ARBEIT", "BLOCKIERT"].includes(w.status) && worker && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-3 items-end">
                {w.status === "OFFEN" && <Btn id={w.id} version={w.version} back={back} resultPlaceholder={resultPlaceholder} action="STARTEN" label="Beginnen" secondary />}
                {w.status === "BLOCKIERT" && <Btn id={w.id} version={w.version} back={back} resultPlaceholder={resultPlaceholder} action="FORTSETZEN" label="Weiter" secondary />}
                {w.status !== "BLOCKIERT" && <Btn id={w.id} version={w.version} back={back} resultPlaceholder={resultPlaceholder} action="BLOCKIEREN" label="Blockiert" secondary note noteLabel="Was blockiert? (Pflicht)" />}
              </div>
              <Btn id={w.id} version={w.version} back={back} resultPlaceholder={resultPlaceholder} action="ABSCHLIESSEN" label={w.reviewRequired && !r.requester ? "Ergebnis zur Prüfung geben" : "Abschließen"} result />
            </div>
          )}
          {["OFFEN", "IN_ARBEIT", "BLOCKIERT"].includes(w.status) && !worker && <p className="text-sm muted">In Bearbeitung bei {w.assigneeName ?? w.teamName}.</p>}
          {["ANGEFRAGT", "OFFEN", "IN_ARBEIT", "BLOCKIERT"].includes(w.status) && !worker && r.requester && (
            <Btn id={w.id} version={w.version} back={back} resultPlaceholder="z. B. hat sich anders erledigt, Kunde hat intern besetzt" action="ABSCHLIESSEN" label="Selbst als erledigt setzen" secondary result />
          )}
          {w.status === "ZUR_PRUEFUNG" && r.requester && (
            <div className="flex flex-wrap gap-3 items-end">
              <Btn id={w.id} version={w.version} back={back} resultPlaceholder={resultPlaceholder} action="ABNEHMEN" label="Abnehmen" />
              <Btn id={w.id} version={w.version} back={back} resultPlaceholder={resultPlaceholder} action="ZURUECKGEBEN" label="Zur Nacharbeit" secondary note noteLabel="Was fehlt noch? (Pflicht)" />
            </div>
          )}
          {w.status === "ZUR_PRUEFUNG" && !r.requester && <p className="text-sm muted">Liegt zur Prüfung bei {w.requesterName}.</p>}
          {w.status === "ABGELEHNT" && r.requester && (
            <form action={workItemAction} className="flex flex-wrap gap-2 items-end">
              <input type="hidden" name="workItemId" value={w.id} />
              <input type="hidden" name="version" value={w.version} />
              <input type="hidden" name="back" value={back} />
              <input type="hidden" name="action" value="ERNEUT_ANFRAGEN" />
              <div>
                <label className="label" htmlFor="again">Erneut anfragen bei</label>
                <select id="again" name="target" className="input">
                  {targets.teams.map((t) => <option key={t.id} value={`team:${t.id}`}>{t.name} (Team)</option>)}
                  {targets.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
              <button className="btn btn-small" type="submit">Anfragen</button>
            </form>
          )}
          {w.teamId && w.assigneeUserId && !r.assignee && r.teamMember && <Btn id={w.id} version={w.version} back={back} resultPlaceholder={resultPlaceholder} action="UEBERNEHMEN" label="Selbst übernehmen" secondary />}
          {(r.requester || r.teamLead) && <Btn id={w.id} version={w.version} back={back} resultPlaceholder={resultPlaceholder} action="VERWERFEN" label="Verwerfen" secondary note noteLabel="Begründung (optional)" />}
        </section>
      )}

      {checklist.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Checkliste ({checklist.filter((c) => c.done).length}/{checklist.length})</h2>
          <ul className="space-y-1">
            {checklist.map((c, i) => (
              <li key={i} className="text-sm">
                <form action={toggleChecklistAction} className="inline-flex items-center gap-2">
                  <input type="hidden" name="workItemId" value={w.id} />
                  <input type="hidden" name="version" value={w.version} />
                  <input type="hidden" name="back" value={back} />
                  <input type="hidden" name="index" value={i} />
                  <input type="hidden" name="done" value={c.done ? "false" : "true"} />
                  <button type="submit" className="btn btn-secondary btn-small" disabled={final || !(r.assignee || r.requester || (r.teamMember && !w.assigneeUserId))} aria-label={c.done ? `${c.text}: wieder öffnen` : `${c.text}: abhaken`}>
                    {c.done ? "✓" : "○"}
                  </button>
                  <span style={c.done ? { textDecoration: "line-through", opacity: 0.7 } : undefined}>{c.text}</span>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2 className="font-semibold mb-2">Unteraufgaben{d.children.length ? ` (${d.children.filter((c) => c.status !== "ERLEDIGT" && c.status !== "VERWORFEN").length} offen)` : ""}</h2>
        <WorkList items={d.children} empty="Keine Unteraufgaben." showAccount={false} />
        {!final && (r.assignee || r.requester || r.teamMember) && (
          <details className="mt-2">
            <summary>Unteraufgabe anlegen</summary>
            <WorkCreateForm users={targets.users} teams={targets.teams} back={back} parentId={w.id} compact idPrefix="sub" />
          </details>
        )}
      </section>

      {!final && (r.requester || r.teamLead || r.assignee) && (
        <section className="card grid sm:grid-cols-2 gap-4">
          <form action={reassignWorkItemAction} className="flex flex-wrap gap-2 items-end">
            <input type="hidden" name="workItemId" value={w.id} />
            <input type="hidden" name="version" value={w.version} />
            <input type="hidden" name="back" value={back} />
            <div>
              <label className="label" htmlFor="reassign">Umverteilen an</label>
              <select id="reassign" name="target" className="input" defaultValue="">
                <option value="" disabled>bitte wählen</option>
                {(w.teamId ? d.teamMembers : d.users).filter((u) => u.id !== w.assigneeUserId).map((u) => (
                  <option key={u.id} value={u.id}>{u.name}{u.id === actor.userId ? " (ich)" : ""}</option>
                ))}
              </select>
            </div>
            <button className="btn btn-secondary btn-small" type="submit">Umverteilen</button>
          </form>
          <form action={updateWorkItemAction} className="flex flex-wrap gap-2 items-end">
            <input type="hidden" name="workItemId" value={w.id} />
            <input type="hidden" name="version" value={w.version} />
            <input type="hidden" name="back" value={back} />
            <div>
              <label className="label" htmlFor="due">Frist</label>
              <input id="due" type="date" name="dueDate" className="input" defaultValue={w.dueDate ?? ""} />
            </div>
            <div>
              <label className="label" htmlFor="prio">Priorität</label>
              <select id="prio" name="priority" className="input" defaultValue={w.priority}>
                <option value="NORMAL">normal</option>
                <option value="HOCH">dringend</option>
              </select>
            </div>
            <button className="btn btn-secondary btn-small" type="submit">Speichern</button>
          </form>
        </section>
      )}

      <section className="card text-sm flex flex-wrap gap-3 items-center">
        <span className="muted">Beobachtet von: {d.watchers.length ? d.watchers.map((x) => x.name).join(", ") : "niemandem"}</span>
        <form action={watchWorkItemAction}>
          <input type="hidden" name="workItemId" value={w.id} />
          <input type="hidden" name="back" value={back} />
          <input type="hidden" name="watch" value={r.watcher ? "0" : "1"} />
          <button className="btn btn-secondary btn-small" type="submit">{r.watcher ? "Nicht mehr beobachten" : "Beobachten"}</button>
        </form>
      </section>

      <Comments actor={actor} subjectType="VORGANG" subjectId={w.id} back={back} />

      <section className="card">
        <details>
          <summary className="font-semibold">Verlauf ({d.history.length})</summary>
          <ul className="text-sm mt-2 space-y-1">
            {d.history.map((h, i) => (
              <li key={i}>
                <span className="muted">{fmtDateTime(h.at)}</span> · {h.who}: {ACTION_TEXT[h.action] ?? h.action}
                {h.changes && "nach" in h.changes ? ` → ${workStatusLabel[String(h.changes.nach)] ?? String(h.changes.nach)}` : ""}
              </li>
            ))}
          </ul>
        </details>
      </section>
    </div>
  );
}
