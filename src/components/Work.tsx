import Link from "next/link";
import type { Actor } from "@/modules/identity/actor";
import { listWorkForSubject, workKindLabel, workStatusLabel, workTargets, type WorkItemView } from "@/modules/work/service";
import { listComments, type CommentSubject } from "@/modules/comments/service";
import { addCommentAction, deleteCommentAction, editCommentAction } from "@/app/actions";
import { fmtDate } from "@/lib/labels";
import { WorkCreateForm } from "./WorkCreateForm";

const RED = "#c0392b";
const AMBER = "#b7791f";

export function SlaBadge({ state }: { state: "OK" | "KNAPP" | "VERLETZT" | null }) {
  if (!state) return null;
  const map = { OK: { t: "SLA ok", c: "var(--muted, #666)" }, KNAPP: { t: "SLA knapp", c: AMBER }, VERLETZT: { t: "SLA überschritten", c: RED } } as const;
  return (
    <span className="text-xs" style={{ color: map[state].c, fontWeight: state === "OK" ? 400 : 600 }}>
      {map[state].t}
    </span>
  );
}

/** Kompakte Liste von Vorgängen */
export function WorkList({ items, empty, showAccount = true, perspective }: { items: WorkItemView[]; empty: string; showAccount?: boolean; perspective?: "assignee" | "requester" | "queue" }) {
  if (!items.length) return <p className="muted text-sm">{empty}</p>;
  return (
    <ul className="space-y-2">
      {items.map((w) => (
        <li key={w.id} className="text-sm" style={{ borderLeft: `3px solid ${w.overdue ? RED : w.priority === "HOCH" ? AMBER : "var(--border)"}`, paddingLeft: ".6rem" }}>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Link href={`/vorgaenge/${w.id}`}>
              <strong>{w.title}</strong>
            </Link>
            <span className="status">{workStatusLabel[w.status] ?? w.status}</span>
            {w.priority === "HOCH" && <span className="text-xs" style={{ color: AMBER, fontWeight: 600 }}>dringend</span>}
            <SlaBadge state={w.slaState} />
          </div>
          <div className="muted text-xs">
            {workKindLabel[w.kind] ?? w.kind}
            {w.serviceName ? ` · ${w.serviceName}` : ""}
            {showAccount && w.accountName ? ` · ${w.accountName}` : ""}
            {perspective !== "requester" && w.requesterUserId !== w.assigneeUserId ? ` · von ${w.requesterName}` : ""}
            {perspective !== "assignee" ? ` · ${w.assigneeName ? `bei ${w.assigneeName}` : w.teamName ? `in ${w.teamName} (noch nicht übernommen)` : ""}` : ""}
            {w.deputyForName ? ` · Vertretung für ${w.deputyForName}` : ""}
            {w.dueDate ? <span style={w.overdue ? { color: RED, fontWeight: 600 } : undefined}> · bis {fmtDate(w.dueDate)}{w.overdue ? " (überfällig)" : ""}</span> : ""}
          </div>
          {w.status === "ABGELEHNT" && w.statusNote && <div className="text-xs">Abgelehnt: {w.statusNote}</div>}
          {w.status === "BLOCKIERT" && w.statusNote && <div className="text-xs">Blockiert: {w.statusNote}</div>}
        </li>
      ))}
    </ul>
  );
}

/** Block „Vorgänge“ an Kunde, Setup, Chance oder SOS: offene Vorgänge, zuletzt erledigte, neuer Vorgang. */
export async function WorkBlock({ actor, subjectType, subjectId, back, title = "Vorgänge", canCreate = true }: { actor: Actor; subjectType: "KUNDE" | "SETUP" | "CHANCE" | "SOS"; subjectId: string; back: string; title?: string; canCreate?: boolean }) {
  const [list, targets] = await Promise.all([listWorkForSubject(actor, subjectType, subjectId), workTargets(actor)]);
  return (
    <section className="card" id="vorgaenge">
      <div className="flex flex-wrap items-baseline gap-2 mb-2">
        <h2 className="font-semibold">
          {title}
          {list.open.length ? ` (${list.open.length} offen)` : ""}
        </h2>
        <span className="muted text-xs">Aufgaben und Anfragen an Kolleg:innen oder Teams – mit Annahme, Frist und Rückmeldung.</span>
      </div>
      <WorkList items={list.open} empty="Keine offenen Vorgänge." showAccount={false} />
      {list.done.length > 0 && (
        <details className="text-sm mt-2">
          <summary>Zuletzt abgeschlossen ({list.done.length})</summary>
          <div className="mt-2">
            <WorkList items={list.done} empty="" showAccount={false} />
          </div>
        </details>
      )}
      {canCreate && (
        <details className="mt-2">
          <summary>Vorgang anlegen oder anfragen</summary>
          <WorkCreateForm users={targets.users} teams={targets.teams} subjectType={subjectType} subjectId={subjectId} back={`${back}#vorgaenge`} idPrefix={`wb-${subjectType}`} />
        </details>
      )}
    </section>
  );
}

/** Kommentare am Objekt mit @-Erwähnungen */
export async function Comments({ actor, subjectType, subjectId, back }: { actor: Actor; subjectType: CommentSubject; subjectId: string; back: string }) {
  const list = await listComments(actor, subjectType, subjectId);
  const backTo = `${back.split("#")[0]}#kommentare`;
  return (
    <section className="card" id="kommentare">
      <div className="flex flex-wrap items-baseline gap-2 mb-2">
        <h2 className="font-semibold">Kommentare{list.length ? ` (${list.filter((c) => !c.deletedAt).length})` : ""}</h2>
        <span className="muted text-xs">Rückfragen und Absprachen direkt am Objekt. Mit „@Vorname Nachname“ erwähnst du jemanden – die Person wird benachrichtigt.</span>
      </div>
      {list.length === 0 && <p className="muted text-sm">Noch keine Kommentare.</p>}
      <ul className="space-y-3">
        {list.map((c) => (
          <li key={c.id} className="text-sm">
            <div className="muted text-xs">
              <strong style={{ color: "var(--text)" }}>{c.authorName}</strong> · {fmtDate(c.createdAt)} {new Date(c.createdAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })}
              {c.editedAt ? " · bearbeitet" : ""}
              {c.mentionNames.length ? ` · erwähnt: ${c.mentionNames.join(", ")}` : ""}
            </div>
            {c.deletedAt ? <div className="muted italic">(gelöscht)</div> : <div style={{ whiteSpace: "pre-wrap" }}>{c.body}</div>}
            {c.own && !c.deletedAt && (
              <details className="text-xs mt-1">
                <summary>Bearbeiten</summary>
                <form action={editCommentAction} className="flex flex-wrap gap-2 mt-1 items-end">
                  <input type="hidden" name="commentId" value={c.id} />
                  <input type="hidden" name="back" value={backTo} />
                  <textarea name="body" className="input" rows={2} defaultValue={c.body} style={{ minWidth: 280 }} />
                  <button className="btn btn-secondary btn-small" type="submit">Speichern</button>
                </form>
                <form action={deleteCommentAction} className="mt-1">
                  <input type="hidden" name="commentId" value={c.id} />
                  <input type="hidden" name="back" value={backTo} />
                  <button className="btn btn-secondary btn-small" type="submit">Löschen</button>
                </form>
              </details>
            )}
          </li>
        ))}
      </ul>
      <form action={addCommentAction} className="mt-3 flex flex-col gap-2">
        <input type="hidden" name="subjectType" value={subjectType} />
        <input type="hidden" name="subjectId" value={subjectId} />
        <input type="hidden" name="back" value={backTo} />
        <label className="label sr-only" htmlFor={`c-${subjectType}-${subjectId}`}>Kommentar</label>
        <textarea id={`c-${subjectType}-${subjectId}`} name="body" className="input" rows={2} maxLength={4000} required placeholder="Kommentar schreiben … @Name erwähnt eine Person" />
        <div>
          <button className="btn btn-small" type="submit">Kommentieren</button>
        </div>
      </form>
    </section>
  );
}
