import Link from "next/link";
import { ProcessStepper } from "@/components/ProcessStepper";
import { Status } from "@/components/Status";
import { actionStatusLabel, fmtDate, playbookRunStatusLabel } from "@/lib/labels";
import type { RunView } from "@/modules/playbooks/service";
import { CopyButton } from "@/components/CopyButton";
import { draftKindLabel, type StepDrafts } from "@/modules/playbooks/drafts";
import { completeRunStepAction, draftRunStepAction, pauseRunAction, reassignRunOwnerAction, resumeRunAction, skipRunStepAction, startPlaybookRunAction } from "@/app/actions";

type User = { id: string; displayName: string };
type PlaybookOption = { id: string; name: string; description: string | null; steps: { id: string }[] };

/**
 * Vorgehensmuster an einem Objekt (Etappe 20): laufende/zurückgestellte/abgeschlossene Vorgehen mit Prozessleiste,
 * der aktuelle Schritt mit Ziel, MEDDPICC-Bezug, Vorschlag und Erledigt-Kriterium – und das Starten eines Musters.
 */
export function PlaybookRuns({
  runs,
  back,
  users,
  start,
}: {
  runs: RunView[];
  back: string;
  users: User[];
  start?: {
    playbooks: PlaybookOption[];
    hidden: Record<string, string>;
    /** Nur Kunden-Muster: bestehendes Setup wählen oder neues anlegen */
    setups?: { id: string; name: string }[];
    defaultNewSetupName?: string;
    defaultOwnerId?: string | null;
    /** Vorausgewähltes Muster samt kurzer Begründung (z. B. Reaktivierungs-Setup → Altkunden-Reaktivierung) */
    recommendedId?: string | null;
    recommendation?: string | null;
  } | null;
}) {
  const active = runs.filter((r) => r.status === "AKTIV");
  const other = runs.filter((r) => r.status !== "AKTIV");
  return (
    <section className="card" id="vorgehen">
      <div className="flex flex-wrap items-baseline gap-3 mb-2">
        <h2 className="font-semibold">Vorgehen ({active.length} laufend)</h2>
        <Link href="/vorgehen" className="muted text-sm ml-auto">Alle Vorgehensmuster ansehen</Link>
      </div>
      {runs.length === 0 && <p className="muted text-sm">Hier läuft noch kein Standard-Vorgehen. Ein Vorgehensmuster gibt Schritt für Schritt Orientierung – jeder Schritt wird als Aktion angelegt und darf begründet übersprungen werden.</p>}
      <div className="space-y-4">
        {active.map((r) => <RunCard key={r.id} r={r} back={back} users={users} />)}
      </div>
      {other.length > 0 && (
        <details className="mt-3">
          <summary className="text-sm">Abgeschlossene und zurückgestellte Vorgehen ({other.length})</summary>
          <div className="space-y-4 mt-2">{other.map((r) => <RunCard key={r.id} r={r} back={back} users={users} />)}</div>
        </details>
      )}
      {start && start.playbooks.length > 0 && (
        <details className="mt-4" open={runs.length === 0}>
          <summary>Vorgehen starten</summary>
          {start.recommendation && <p className="text-sm mt-2" style={{ background: "var(--warn-soft)", borderRadius: 8, padding: ".5rem .8rem" }}>{start.recommendation}</p>}
          <form action={startPlaybookRunAction} className="mt-2 grid sm:grid-cols-2 gap-3">
            <input type="hidden" name="back" value={back} />
            {Object.entries(start.hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            <div className="sm:col-span-2">
              <label className="label" htmlFor="pbSelect">Vorgehensmuster</label>
              <select id="pbSelect" name="playbookId" className="select" required defaultValue={start.recommendedId ?? start.playbooks[0]!.id}>
                {start.playbooks.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.steps.length} Schritte)</option>)}
              </select>
              <ul className="muted text-xs mt-1 space-y-0.5">{start.playbooks.map((p) => <li key={p.id}><strong>{p.name}:</strong> {p.description}</li>)}</ul>
            </div>
            {start.setups && (
              <>
                <div>
                  <label className="label" htmlFor="pbSetup">In bestehendem Setup</label>
                  <select id="pbSetup" name="setupId" className="select" defaultValue="">
                    <option value="">– neues Setup anlegen –</option>
                    {start.setups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="pbNewSetup">Name des neuen Setups (falls kein bestehendes)</label>
                  <input id="pbNewSetup" name="newSetupName" className="input" defaultValue={start.defaultNewSetupName ?? ""} maxLength={200} />
                </div>
              </>
            )}
            <div>
              <label className="label" htmlFor="pbOwner">Verantwortlich</label>
              <select id="pbOwner" name="ownerUserId" className="select" defaultValue={start.defaultOwnerId ?? ""}>
                <option value="">– zuständiger BD –</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </select>
            </div>
            <div className="flex items-end"><button className="btn" type="submit">Vorgehen starten</button></div>
          </form>
        </details>
      )}
    </section>
  );
}

function RunCard({ r, back, users }: { r: RunView; back: string; users: User[] }) {
  const current = r.steps.find((s) => s.status === "OFFEN") ?? null;
  const done = r.steps.filter((s) => s.status === "ERLEDIGT" || s.status === "UEBERSPRUNGEN");
  return (
    <div className="border rounded-md p-3" style={{ borderColor: "var(--border)" }}>
      <div className="flex flex-wrap items-baseline gap-2 mb-2">
        <strong>{r.playbookName}</strong>
        <Status label={playbookRunStatusLabel[r.status] ?? r.status} />
        <span className="muted text-sm">verantwortlich: {r.ownerName} · Setup: <Link href={`/setups/${r.setupId}`}>{r.setupName}</Link>{r.opportunityId && r.opportunityTitle ? <> · Chance: <Link href={`/bedarfe/${r.opportunityId}`}>{r.opportunityTitle}</Link></> : null} · gestartet {fmtDate(r.createdAt)}</span>
      </div>
      <ProcessStepper
        steps={r.steps.map((s) => ({ key: s.id, label: s.title }))}
        currentKey={current?.id ?? (r.status === "ABGESCHLOSSEN" ? r.steps[r.steps.length - 1]?.id ?? "" : "")}
        endState={r.status === "ZURUECKGESTELLT" ? { label: "zurückgestellt", reason: r.closedReason, tone: "warn" } : null}
      />
      {r.status === "ABGESCHLOSSEN" && <p className="text-sm mt-2">Alle Schritte bearbeitet.</p>}

      {current && r.status === "AKTIV" && (
        <div className="mt-3 text-sm space-y-1">
          <div className="font-medium">Aktueller Schritt {current.position}/{r.steps.length}: {current.title}</div>
          {current.goal && <p><span className="muted">Wozu: </span>{current.goal}</p>}
          {current.meddpicc && <p><span className="muted">MEDDPICC: </span>{current.meddpicc}</p>}
          {current.suggestedAction && <p><span className="muted">Vorschlag: </span>{current.suggestedAction}</p>}
          {current.doneCriterion && <p><span className="muted">Erledigt, wenn: </span>{current.doneCriterion}</p>}
          {current.action && (
            <p className="muted">
              Aktion bei {current.action.ownerName}: {actionStatusLabel[current.action.status] ?? current.action.status}
              {current.action.dueDate && ` · Richttermin ${fmtDate(current.action.dueDate)}`}
              {current.action.status === "VORGESCHLAGEN" && " – wartet auf Annahme (in „Meine Arbeit“)"}
            </p>
          )}
          {r.canWork && <StepDraftsView stepId={current.id} drafts={current.drafts as StepDrafts | null} note={current.draftsNote} at={current.draftsAt} back={back} />}
          {r.canWork && (
            <div className="grid lg:grid-cols-2 gap-3 mt-2">
              <form action={completeRunStepAction} className="flex flex-wrap gap-2 items-end">
                <input type="hidden" name="runStepId" value={current.id} />
                <input type="hidden" name="back" value={back} />
                <div className="grow"><label className="label" htmlFor={`res-${current.id}`}>Ergebnis</label><input id={`res-${current.id}`} name="result" className="input" required minLength={5} placeholder="Was ist herausgekommen?" /></div>
                <button className="btn btn-small" type="submit">Schritt erledigt</button>
              </form>
              <form action={skipRunStepAction} className="flex flex-wrap gap-2 items-end">
                <input type="hidden" name="runStepId" value={current.id} />
                <input type="hidden" name="back" value={back} />
                <div className="grow"><label className="label" htmlFor={`skip-${current.id}`}>Begründung</label><input id={`skip-${current.id}`} name="reason" className="input" required minLength={5} placeholder="Warum passt der Schritt hier nicht?" /></div>
                <button className="btn btn-secondary btn-small" type="submit">Überspringen</button>
              </form>
            </div>
          )}
        </div>
      )}

      {done.length > 0 && (
        <details className="mt-2">
          <summary className="text-sm">Bisherige Schritte ({done.length})</summary>
          <ul className="text-sm mt-1 space-y-1">
            {done.map((s) => (
              <li key={s.id}>
                {s.position}. {s.title} – {s.status === "ERLEDIGT" ? <>erledigt{s.result ? `: ${s.result}` : ""}</> : <span className="muted">übersprungen: {s.skipReason}</span>}
                {s.completedAt && <span className="muted"> ({fmtDate(s.completedAt)})</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex flex-wrap gap-4 mt-3">
        {r.canReassign && r.status !== "ABGESCHLOSSEN" && (
          <form action={reassignRunOwnerAction} className="flex flex-wrap gap-2 items-end text-sm">
            <input type="hidden" name="runId" value={r.id} />
            <input type="hidden" name="version" value={r.version} />
            <input type="hidden" name="back" value={back} />
            <div>
              <label className="label" htmlFor={`own-${r.id}`}>Verantwortung umstellen</label>
              <select id={`own-${r.id}`} name="ownerUserId" className="select" required defaultValue="">
                <option value="" disabled>Bitte wählen …</option>
                {users.filter((u) => u.id !== r.ownerUserId).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </select>
            </div>
            <button className="btn btn-secondary btn-small" type="submit">Umstellen</button>
          </form>
        )}
        {r.canWork && r.status === "AKTIV" && (
          <form action={pauseRunAction} className="flex flex-wrap gap-2 items-end text-sm">
            <input type="hidden" name="runId" value={r.id} />
            <input type="hidden" name="version" value={r.version} />
            <input type="hidden" name="back" value={back} />
            <div><label className="label" htmlFor={`pause-${r.id}`}>Zurückstellen – Grund</label><input id={`pause-${r.id}`} name="reason" className="input" required minLength={5} placeholder="z. B. Wiedervorlage in 6 Monaten" /></div>
            <button className="btn btn-secondary btn-small" type="submit">Zurückstellen</button>
          </form>
        )}
        {r.canWork && r.status === "ZURUECKGESTELLT" && (
          <form action={resumeRunAction} className="flex items-end text-sm">
            <input type="hidden" name="runId" value={r.id} />
            <input type="hidden" name="version" value={r.version} />
            <input type="hidden" name="back" value={back} />
            <button className="btn btn-secondary btn-small" type="submit">Wieder aufnehmen</button>
          </form>
        )}
      </div>
    </div>
  );
}

/** Schritt-Assistent: Entwürfe erstellen/erneuern und anzeigen (kopierbar, nie automatisch versendet). */
function StepDraftsView({ stepId, drafts, note, at, back }: { stepId: string; drafts: StepDrafts | null; note: string | null; at: Date | null; back: string }) {
  return (
    <div className="mt-3 p-3" style={{ background: "var(--accent-soft)", borderRadius: 8 }}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">Schritt-Assistent</span>
        <span className="muted text-xs">Entwürfe für Mail, Gesprächsleitfaden, Metriken, Fragen oder Pitch – aus Schritt und bekannten Kundendaten; Platzhalter in [Klammern] ergänzen.</span>
        <form action={draftRunStepAction} className="ml-auto">
          <input type="hidden" name="runStepId" value={stepId} />
          <input type="hidden" name="back" value={back} />
          <button className="btn btn-small" type="submit">{drafts ? "Entwürfe neu erstellen" : "Entwürfe erstellen"}</button>
        </form>
      </div>
      {drafts && (
        <div className="mt-3 space-y-3">
          {drafts.summary && <p className="text-sm">{drafts.summary}</p>}
          {drafts.drafts.map((d, i) => (
            <div key={i} className="card" style={{ padding: ".8rem 1rem" }}>
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <Status label={draftKindLabel[d.kind] ?? d.kind} />
                <strong className="text-sm">{d.title}</strong>
                <span className="ml-auto"><CopyButton text={d.text} /></span>
              </div>
              <pre className="text-sm whitespace-pre-wrap" style={{ fontFamily: "inherit", margin: 0 }}>{d.text}</pre>
              {d.basedOn.length > 0 && <p className="muted text-xs mt-1">Beruht auf: {d.basedOn.map((q) => `„${q.slice(0, 140)}“`).join(" · ")}</p>}
            </div>
          ))}
          {drafts.openQuestions.length > 0 && (
            <div className="text-sm"><span className="muted">Offene Fragen: </span>{drafts.openQuestions.join(" · ")}</div>
          )}
          <p className="muted text-xs">{note}{at ? ` · erstellt ${fmtDate(at)}` : ""}</p>
        </div>
      )}
    </div>
  );
}
