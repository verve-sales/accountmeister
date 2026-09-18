import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { hasRole } from "@/modules/identity/actor";
import { getGoal } from "@/modules/leadership/service";
import { listVisibleAccounts } from "@/modules/accounts/service";
import { listMySetups } from "@/modules/setups/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { fmtDate, fmtDateTime, goalStatusLabel } from "@/lib/labels";
import { addGoalContributionAction, changeGoalStatusAction, updateGoalAction } from "../../actions";

const nextStatus: Record<string, { value: string; label: string }[]> = {
  ENTWURF: [
    { value: "ZUR_ABSTIMMUNG", label: "Zur Abstimmung geben" },
    { value: "VEREINBART", label: "Zustimmen (vereinbaren)" },
    { value: "BEENDET", label: "Beenden" },
  ],
  ZUR_ABSTIMMUNG: [
    { value: "VEREINBART", label: "Zustimmen (vereinbaren)" },
    { value: "ENTWURF", label: "Zurück in Entwurf" },
    { value: "BEENDET", label: "Beenden" },
  ],
  VEREINBART: [{ value: "BEENDET", label: "Beenden" }],
  GEAENDERT: [
    { value: "ZUR_ABSTIMMUNG", label: "Zur Abstimmung geben" },
    { value: "VEREINBART", label: "Erneut zustimmen" },
    { value: "BEENDET", label: "Beenden" },
  ],
  BEENDET: [],
};

export default async function ZielPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let goal;
  try {
    goal = await getGoal(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const isLeader = hasRole(actor, "PRINCIPAL") || hasRole(actor, "CEO");
  const [accounts, setups, users] = await Promise.all([
    listVisibleAccounts(actor),
    listMySetups(actor),
    db.query.users.findMany({ where: eq(schema.users.status, "ACTIVE"), orderBy: (u, { asc }) => [asc(u.displayName)] }),
  ]);
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const accountName = (aid: string | null) => (aid ? accounts.find((a) => a.id === aid)?.name ?? "(nicht sichtbar)" : "–");
  const cur = goal.current;
  const finished = goal.status === "BEENDET";
  const transitions = nextStatus[goal.status] ?? [];
  const alreadyAgreed = goal.agreedByUserIds.includes(actor.userId);

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/ziele">Ziele & Portfolio</Link> › {goal.title}
      </p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{goal.title}</h1>
        <Status label={goalStatusLabel[goal.status] ?? goal.status} />
        <span className="muted text-sm">
          Verantwortlich: {goal.ownerName} · Kundenbezug: {accountName(goal.accountId)} · Version {cur?.versionNo ?? "–"} von {goal.versionCount}
        </span>
      </div>
      <Feedback params={sp} />

      <section className="card">
        <h2 className="font-semibold mb-2">Aktuelle Fassung</h2>
        {cur ? (
          <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div className="sm:col-span-2"><dt className="muted">Gewünschtes Ergebnis</dt><dd>{cur.desiredOutcome}</dd></div>
            <div><dt className="muted">Geltungsbereich</dt><dd>{cur.scope ?? "–"}</dd></div>
            <div><dt className="muted">Zeitraum</dt><dd>{cur.periodFrom || cur.periodTo ? `${fmtDate(cur.periodFrom)} – ${fmtDate(cur.periodTo)}` : "–"}</dd></div>
            <div className="sm:col-span-2"><dt className="muted">Beobachtbares Erfolgskriterium</dt><dd>{cur.successCriterion ?? "–"}</dd></div>
            <div><dt className="muted">Ausgangslage</dt><dd>{cur.baseline ?? "–"}{cur.baselineSourceId && <> · <Link href={`/quellen/${cur.baselineSourceId}`}>Quelle</Link></>}</dd></div>
            <div><dt className="muted">Zielwert</dt><dd>{cur.targetValue ?? <span className="muted">kein Zielwert vereinbart</span>}</dd></div>
            <div><dt className="muted">Benötigte Unterstützung</dt><dd>{cur.supportNeeded ?? "–"}</dd></div>
            <div><dt className="muted">Voraussetzungen</dt><dd>{cur.prerequisites ?? "–"}</dd></div>
          </dl>
        ) : <p className="muted text-sm">Keine Fassung vorhanden.</p>}
        <p className="text-sm mt-3">
          Vereinbarung: {goal.agreedByNames.length > 0 ? `zugestimmt von ${goal.agreedByNames.join(", ")}` : "noch keine Zustimmung"}.
          {goal.status !== "VEREINBART" && goal.status !== "BEENDET" && <span className="muted"> „Vereinbart“ wird das Ziel erst mit Zustimmung von CEO und Principal.</span>}
        </p>
        {isLeader && !finished && transitions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {transitions.map((t) => (
              <form key={t.value} action={changeGoalStatusAction}>
                <input type="hidden" name="goalId" value={goal.id} />
                <input type="hidden" name="version" value={goal.version} />
                <input type="hidden" name="status" value={t.value} />
                <button className={t.value === "BEENDET" ? "btn btn-secondary" : "btn"} type="submit" disabled={t.value === "VEREINBART" && alreadyAgreed}>
                  {t.value === "VEREINBART" && alreadyAgreed ? "Ihre Zustimmung liegt vor" : t.label}
                </button>
              </form>
            ))}
          </div>
        )}
      </section>

      {isLeader && !finished && cur && (
        <section className="card">
          <h2 className="font-semibold mb-2">Neue Fassung (Version {(goal.versionCount ?? 0) + 1})</h2>
          <p className="muted text-sm mb-2">Ein vereinbartes Ziel wird durch eine neue Fassung „geändert“ und braucht die erneute Zustimmung beider Rollen. Die bisherigen Fassungen bleiben erhalten.</p>
          <form action={updateGoalAction} className="grid sm:grid-cols-2 gap-3">
            <input type="hidden" name="goalId" value={goal.id} />
            <input type="hidden" name="version" value={goal.version} />
            <div><label className="label" htmlFor="uTitle">Titel</label><input id="uTitle" name="title" className="input" required minLength={3} defaultValue={goal.title} /></div>
            <div>
              <label className="label" htmlFor="uOwner">Verantwortlich</label>
              <select id="uOwner" name="ownerUserId" className="select" defaultValue={goal.ownerUserId}>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
            </div>
            <div className="sm:col-span-2"><label className="label" htmlFor="uOutcome">Gewünschtes Ergebnis</label><textarea id="uOutcome" name="desiredOutcome" className="textarea" required minLength={5} defaultValue={cur.desiredOutcome} /></div>
            <div><label className="label" htmlFor="uScope">Geltungsbereich</label><input id="uScope" name="scope" className="input" defaultValue={cur.scope ?? ""} /></div>
            <div>
              <label className="label" htmlFor="uAccount">Kundenbezug</label>
              <select id="uAccount" name="accountId" className="select" defaultValue={goal.accountId ?? ""}><option value="">–</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            </div>
            <div><label className="label" htmlFor="uFrom">Zeitraum von</label><input id="uFrom" name="periodFrom" type="date" className="input" defaultValue={cur.periodFrom ?? ""} /></div>
            <div><label className="label" htmlFor="uTo">bis</label><input id="uTo" name="periodTo" type="date" className="input" defaultValue={cur.periodTo ?? ""} /></div>
            <div className="sm:col-span-2"><label className="label" htmlFor="uCrit">Beobachtbares Erfolgskriterium</label><input id="uCrit" name="successCriterion" className="input" defaultValue={cur.successCriterion ?? ""} /></div>
            <div><label className="label" htmlFor="uBase">Ausgangslage</label><input id="uBase" name="baseline" className="input" defaultValue={cur.baseline ?? ""} /></div>
            <div><label className="label" htmlFor="uTarget">Zielwert (nur falls vereinbart)</label><input id="uTarget" name="targetValue" className="input" defaultValue={cur.targetValue ?? ""} /></div>
            <div><label className="label" htmlFor="uSupport">Benötigte Unterstützung</label><input id="uSupport" name="supportNeeded" className="input" defaultValue={cur.supportNeeded ?? ""} /></div>
            <div><label className="label" htmlFor="uPre">Voraussetzungen</label><input id="uPre" name="prerequisites" className="input" defaultValue={cur.prerequisites ?? ""} /></div>
            <div className="sm:col-span-2"><label className="label" htmlFor="uNote">Grund der Änderung{goal.status !== "ENTWURF" && " (erforderlich)"}</label><input id="uNote" name="changeNote" className="input" required={goal.status !== "ENTWURF"} /></div>
            <div className="sm:col-span-2"><button className="btn" type="submit">Neue Fassung speichern</button></div>
          </form>
        </section>
      )}

      <section className="card">
        <h2 className="font-semibold mb-2">Zielbeiträge ({goal.contributions.length})</h2>
        <p className="muted text-sm mb-2">Erwarteter und belegter Beitrag werden getrennt geführt. Ein belegter Beitrag braucht eine Quelle.</p>
        {goal.contributions.length === 0 ? <p className="muted text-sm">Noch keine Beiträge.</p> : (
          <table className="list">
            <thead><tr><th>Bezug</th><th>Erwartet</th><th>Belegt</th><th>Von</th></tr></thead>
            <tbody>
              {goal.contributions.map((c) => (
                <tr key={c.id}>
                  <td className="text-sm">{c.setupId ? <Link href={`/setups/${c.setupId}`}>{setups.find((s) => s.id === c.setupId)?.name ?? "Setup"}</Link> : accountName(c.accountId)}</td>
                  <td className="text-sm">{c.expectedContribution ?? "–"}</td>
                  <td className="text-sm">{c.evidencedContribution ?? "–"}{c.evidenceSourceId && <> · <Link href={`/quellen/${c.evidenceSourceId}`}>Quelle</Link></>}</td>
                  <td className="text-sm">{un.get(c.createdBy) ?? "?"} · {fmtDateTime(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!finished && (
          <details className="mt-3">
            <summary>Beitrag festhalten</summary>
            <form action={addGoalContributionAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="goalId" value={goal.id} />
              <div>
                <label className="label" htmlFor="cSetup">Setup{!isLeader && " (Pflicht)"}</label>
                <select id="cSetup" name="setupId" className="select" defaultValue="" required={!isLeader}><option value="">–</option>{setups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              </div>
              <div>
                <label className="label" htmlFor="cAccount">Kunde (optional)</label>
                <select id="cAccount" name="accountId" className="select" defaultValue=""><option value="">–</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
              </div>
              <div className="sm:col-span-2"><label className="label" htmlFor="cExpected">Erwarteter Beitrag</label><input id="cExpected" name="expectedContribution" className="input" /></div>
              <div><label className="label" htmlFor="cEvidenced">Belegter Beitrag</label><input id="cEvidenced" name="evidencedContribution" className="input" /></div>
              <div><label className="label" htmlFor="cSource">Quelle des Belegs (Quellen-ID)</label><input id="cSource" name="evidenceSourceId" className="input" placeholder="erforderlich bei belegtem Beitrag" /></div>
              <div className="sm:col-span-2"><button className="btn" type="submit">Beitrag speichern</button></div>
            </form>
          </details>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Änderungshistorie ({goal.versions.length} Fassungen)</h2>
        <ul className="text-sm space-y-1">
          {goal.versions.map((v) => (
            <li key={v.id}>
              <strong>Version {v.versionNo}</strong> · {fmtDateTime(v.createdAt)} · {un.get(v.createdBy) ?? "?"}
              {v.changeNote && <> · Grund: {v.changeNote}</>}
              {v.id === goal.currentVersionId && <span className="muted"> (aktuell)</span>}
              <details><summary className="muted">Fassung anzeigen</summary><p className="mt-1">{v.desiredOutcome}{v.successCriterion && <> · Kriterium: {v.successCriterion}</>}{v.targetValue && <> · Zielwert: {v.targetValue}</>}</p></details>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
