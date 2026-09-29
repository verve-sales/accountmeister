import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DomainError } from "@/lib/errors";
import { getConfig } from "@/lib/config";
import { getCurrentActor } from "@/modules/identity/session";
import { getSetupDetail } from "@/modules/setups/service";
import { listSupportRequestsForSetup } from "@/modules/leadership/service";
import { listOpportunitiesForSetup } from "@/modules/opportunities/service";
import { canReassignResponsibility, loadSetupContext } from "@/modules/identity/authz";
import { analyzeSetup, STAGES, stageLabel } from "@/modules/strategy/analysis";
import { ProcessStepper } from "@/components/ProcessStepper";
import { PlaybookRuns } from "@/components/PlaybookRuns";
import { listPlaybooks, listRuns } from "@/modules/playbooks/service";
import { ALTKUNDEN_CODE } from "@/modules/playbooks/defaults";
import { groupByFamily, listRoles } from "@/modules/roles/catalog";
import { chanceKindLabel, chanceKindValues } from "@/modules/ai/schemas";
import { inArray, or } from "drizzle-orm";
import { getProviderStatus, listOpenQuestionsForSetup, listSuggestionsForSetup } from "@/modules/suggestions/service";
import { SuggestionCard } from "@/components/SuggestionCard";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { SuggestButton } from "@/components/SuggestButton";
import { SetupTabs } from "@/components/SetupTabs";
import {
  accessClassLabel,
  actionChannelLabel,
  actionStatusLabel,
  contributionLabel,
  fmtDate,
  fmtDateTime,
  handoverStatusLabel,
  opportunityStatusLabel,
  setupStatusLabel,
  signalStatusLabel,
  supportStatusLabel,
  sourceTypeLabel,
  visibilityLabel,
} from "@/lib/labels";
import {
  addMemberAction,
  captureObservationAction,
  changeActionStatusAction,
  changeSignalStatusAction,
  createActionAction,
  createHandoverAction,
  createOpportunityAction,
  createSupportRequestAction,
  reassignSetupBdAction,
  removeMemberAction,
  respondHandoverAction,
  respondSupportRequestAction,
  takeOverSignalAction,
  uploadDocumentAction,
  startInterviewAction,
  updateSetupAction,
} from "../../actions";

export default async function SetupPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let d;
  try {
    d = await getSetupDetail(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const back = `/setups/${id}`;
  const allUsers = await db.query.users.findMany({ where: eq(schema.users.status, "ACTIVE"), orderBy: (u, { asc }) => [asc(u.displayName)] });
  const others = allUsers.filter((u) => u.id !== actor.userId);
  const name = (uid: string | null | undefined) => (uid ? d.userNames.get(uid) ?? allUsers.find((u) => u.id === uid)?.displayName ?? "?" : "–");

  const ai = getProviderStatus();
  const maxUploadMb = getConfig().MAX_UPLOAD_MB;
  const [sugg, openQuestions, support, opportunities, roles] = await Promise.all([listSuggestionsForSetup(actor, id), listOpenQuestionsForSetup(id), listSupportRequestsForSetup(actor, id), listOpportunitiesForSetup(actor, id), listRoles(actor.workspaceId)]);
  const roleGroups = groupByFamily(roles);
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const openOpportunities = opportunities.filter((o) => o.status !== "BEENDET");
  const leaderRoles = await db.query.roleAssignments.findMany({ where: or(eq(schema.roleAssignments.role, "PRINCIPAL"), eq(schema.roleAssignments.role, "CEO")) });
  const leaderIds = [...new Set(leaderRoles.map((r) => r.userId))].filter((uid) => uid !== actor.userId);
  const leaders = leaderIds.length ? await db.query.users.findMany({ where: inArray(schema.users.id, leaderIds), orderBy: (u, { asc }) => [asc(u.displayName)] }) : [];
  const openSupport = support.filter((s) => s.status === "ANGEFRAGT" || s.status === "ANGENOMMEN");
  const openSignals = d.signals.filter((s) => s.status !== "BEENDET");
  const linkableSignals = openSignals.filter((s) => s.status !== "MIT_BEDARF_VERKNUEPFT");
  const openActions = d.actions.filter((a) => a.status !== "ERLEDIGT" && a.status !== "VERWORFEN");
  const doneActions = d.actions.filter((a) => a.status === "ERLEDIGT");
  const openHandovers = d.handovers.filter((h) => h.status === "ANGEFRAGT" || h.status === "ANGENOMMEN");
  const recentSignals = d.signals.filter((s) => s.createdAt >= d.recentSince);
  const recentDone = doneActions.filter((a) => a.updatedAt >= d.recentSince);
  const setupCtx = await loadSetupContext(actor, id);
  const analysis = setupCtx ? await analyzeSetup(actor, setupCtx) : null;
  const mayReassign = canReassignResponsibility(actor, d.account);
  const [runs, setupScoped, accountScoped] = await Promise.all([listRuns(actor, { setupId: id }), listPlaybooks(actor, { scope: "SETUP", activeOnly: true }), listPlaybooks(actor, { scope: "ACCOUNT", activeOnly: true })]);
  // Kunden-Muster (z. B. Altkunden-Reaktivierung) lassen sich auch direkt auf ein bestehendes Setup anwenden.
  const setupPlaybooks = [...accountScoped, ...setupScoped];
  const looksLikeReactivation = /reaktiv|re-?entry|wiedereinstieg|altkunde|bestandskunde|historisch/i.test(`${d.setup.name} ${d.setup.contextNote ?? ""}`);
  const reactivation = accountScoped.find((p) => p.code === ALTKUNDEN_CODE);
  // Kunden-Vorgehen dieses Setups werden hier ebenfalls gezeigt; Chancen-Vorgehen auf der jeweiligen Chance.
  // Alle Vorgehen dieses Setups – auch die an einer Chance hängenden (die Karte nennt dann die Chance).
  const setupRuns = runs;

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/kunden">Kunden</Link> › <Link href={`/kunden/${d.account.id}`}>{d.account.name}</Link> › {d.setup.name}
      </p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{d.setup.name}</h1>
        <Status label={setupStatusLabel[d.setup.status] ?? d.setup.status} />
        <span className="muted text-sm">Sichtbarkeit: {visibilityLabel[d.setup.visibility]}</span>
        <span className="muted text-sm">BD: {d.setup.bdUserId ? name(d.setup.bdUserId) : "Zuordnung offen"}</span>
        {!d.canEdit && <span className="muted text-sm">(nur lesend)</span>}
      </div>
      <SetupTabs setupId={id} active="ueberblick" />
      {analysis && (
        <section className="card">
          <h2 className="font-semibold mb-2">Wo stehen wir?</h2>
          <ProcessStepper steps={STAGES.map((s) => ({ key: s, label: stageLabel[s] }))} currentKey={analysis.stage} note={analysis.nextStep} />
          {setupRuns.filter((r) => r.status === "AKTIV").map((r) => {
            const cur = r.steps.find((x) => x.status === "OFFEN");
            return cur ? <p key={r.id} className="text-sm mt-2">Laufendes Vorgehen <a href="#vorgehen">{r.playbookName}</a>: Schritt {cur.position}/{r.steps.length} – {cur.title}</p> : null;
          })}
        </section>
      )}
      <Feedback params={sp} />

      {(setupRuns.length > 0 || d.canEdit || mayReassign) && (
        <PlaybookRuns
          runs={setupRuns}
          back={back}
          users={allUsers.map((u) => ({ id: u.id, displayName: u.displayName }))}
          start={(d.canEdit || mayReassign) && d.setup.status !== "ARCHIVIERT" ? {
            playbooks: setupPlaybooks,
            hidden: { setupId: d.setup.id, accountId: d.account.id },
            defaultOwnerId: d.setup.bdUserId,
            recommendedId: looksLikeReactivation && reactivation ? reactivation.id : null,
            recommendation: looksLikeReactivation && reactivation && !setupRuns.some((r) => r.status === "AKTIV") ? "Dieses Setup sieht nach einer Reaktivierung aus – „Altkunden-Reaktivierung“ führt Schritt für Schritt durch und erstellt je Schritt Entwürfe (Mail, Metriken, Pitch)." : null,
          } : null}
        />
      )}

      {/* 1. Was läuft hier? */}
      <section className="card">
        <h2 className="font-semibold mb-1">1. Was läuft hier?</h2>
        {d.setup.contextNote ? <p>{d.setup.contextNote}</p> : <p className="muted">Noch kein Kontextsatz – bewusster Entwurf. Ergänzen, wenn passend.</p>}
        <div className="text-sm mt-2 muted flex flex-wrap gap-3 items-center">
          <span>Beteiligte:</span>
          {[...new Set(opportunities.filter((o) => o.status !== "BEENDET").map((o) => o.ownerUserId))].filter((uid) => !d.members.some((m) => m.userId === uid)).map((uid) => (
            <span key={`owner-${uid}`} className="inline-flex items-center gap-1">{name(uid)} – verantwortlich für Chance(n)</span>
          ))}
          {d.members.map((m) => (
            <span key={m.userId} className="inline-flex items-center gap-1">
              {m.displayName} – {contributionLabel[m.contribution] ?? m.contribution}
              {m.contributionNote ? ` (${m.contributionNote})` : ""}
              {mayReassign && m.userId !== d.setup.bdUserId && (
                <form action={removeMemberAction} className="inline">
                  <input type="hidden" name="setupId" value={d.setup.id} />
                  <input type="hidden" name="userId" value={m.userId} />
                  <button className="btn btn-secondary btn-small" type="submit" title="Beteiligung entfernen">entfernen</button>
                </form>
              )}
            </span>
          ))}
        </div>
        {mayReassign && (
          <details className="mt-3" open={!d.canEdit}>
            <summary className="text-sm">Zuständigkeit umstellen (BD, Anker)</summary>
            <form action={reassignSetupBdAction} className="mt-2 flex flex-wrap items-end gap-2">
              <input type="hidden" name="setupId" value={d.setup.id} />
              <input type="hidden" name="version" value={d.setup.version} />
              <div>
                <label className="label" htmlFor="reassignSetupBd">Zuständigen BD umstellen</label>
                <select id="reassignSetupBd" name="bdUserId" className="select" required defaultValue="">
                  <option value="" disabled>Bitte wählen …</option>
                  {allUsers.filter((u) => u.id !== d.setup.bdUserId).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                </select>
              </div>
              <button className="btn btn-secondary" type="submit">Umstellen</button>
            </form>
            <form action={addMemberAction} className="mt-3 grid sm:grid-cols-3 gap-3">
              <input type="hidden" name="setupId" value={d.setup.id} />
              <div>
                <label className="label" htmlFor="reassignAnkerUser">Anker (oder andere Beteiligung) umstellen</label>
                <select id="reassignAnkerUser" name="userId" className="select" required defaultValue="">
                  <option value="" disabled>Bitte wählen …</option>
                  {allUsers.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="reassignAnkerContribution">Beitrag</label>
                <select id="reassignAnkerContribution" name="contribution" className="select" defaultValue="ANKER_KONTEXT">
                  {schema.membershipContributionEnum.enumValues.map((v) => <option key={v} value={v}>{contributionLabel[v]}</option>)}
                </select>
              </div>
              <div className="flex items-end"><button className="btn btn-secondary" type="submit">Übernehmen</button></div>
            </form>
            <p className="muted text-xs mt-2">Als Principal, CEO oder aktuell zuständiger BD können Sie BD-Zuordnung und Beteiligungen (z. B. Anker) jederzeit umstellen – unabhängig davon, wer sie ursprünglich zugewiesen hat.</p>
          </details>
        )}
        {d.canEdit && (
          <details className="mt-3">
            <summary className="text-sm">Kontext oder Status bearbeiten</summary>
            <form action={updateSetupAction} className="mt-2 grid sm:grid-cols-3 gap-3">
              <input type="hidden" name="setupId" value={d.setup.id} />
              <input type="hidden" name="version" value={d.setup.version} />
              <div className="sm:col-span-3"><label className="label" htmlFor="contextNote">Kontextsatz</label><textarea id="contextNote" name="contextNote" className="textarea" defaultValue={d.setup.contextNote ?? ""} /></div>
              <div>
                <label className="label" htmlFor="status">Status</label>
                <select id="status" name="status" className="select" defaultValue={d.setup.status}>
                  {schema.setupStatusEnum.enumValues.map((v) => <option key={v} value={v}>{setupStatusLabel[v]}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="visibility">Sichtbarkeit</label>
                <select id="visibility" name="visibility" className="select" defaultValue={d.setup.visibility}>
                  {schema.setupVisibilityEnum.enumValues.map((v) => <option key={v} value={v}>{visibilityLabel[v]}</option>)}
                </select>
              </div>
              <div className="flex items-end"><button className="btn" type="submit">Speichern</button></div>
            </form>
            <form action={addMemberAction} className="mt-4 grid sm:grid-cols-3 gap-3">
              <input type="hidden" name="setupId" value={d.setup.id} />
              <div>
                <label className="label" htmlFor="memberUserId">Beteiligte Person hinzufügen</label>
                <select id="memberUserId" name="userId" className="select" required defaultValue="">
                  <option value="" disabled>Bitte wählen …</option>
                  {allUsers.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="contribution">Vereinbarter Beitrag</label>
                <select id="contribution" name="contribution" className="select" defaultValue="ANKER_KONTEXT">
                  {schema.membershipContributionEnum.enumValues.map((v) => <option key={v} value={v}>{contributionLabel[v]}</option>)}
                </select>
              </div>
              <div className="flex items-end gap-2">
                <input name="contributionNote" className="input" placeholder="Erläuterung (optional)" aria-label="Erläuterung zum Beitrag" />
                <button className="btn btn-secondary" type="submit">Hinzufügen</button>
              </div>
            </form>
          </details>
        )}
      </section>

      {/* 2. Was hat sich geändert? */}
      <section className="card">
        <h2 className="font-semibold mb-1">2. Was hat sich seit dem letzten Weekly geändert?</h2>
        <p className="muted text-sm mb-2">{d.recentLabel}</p>
        {recentSignals.length === 0 && recentDone.length === 0 ? (
          <p className="muted text-sm">Keine neuen Beobachtungen oder erledigten Aktionen seit dem letzten bestätigten Stand.</p>
        ) : (
          <ul className="text-sm space-y-1">
            {recentSignals.map((s) => (
              <li key={s.id}>Neue Beobachtung ({fmtDate(s.createdAt)}, {name(s.createdBy)}): {s.observation}</li>
            ))}
            {recentDone.map((a) => (
              <li key={a.id}>Erledigt ({fmtDate(a.updatedAt)}, {name(a.ownerUserId)}): {a.title} – {a.result}</li>
            ))}
          </ul>
        )}
      </section>

      {/* 3. Was haben wir vereinbart? */}
      {/* Chancen (Etappe 5): je Setup mehrere, unabhängige Zustände (F02); direkt erfassbar (F08) */}
      <section className="card">
        <h2 className="font-semibold mb-2">Chancen ({openOpportunities.length} offen)</h2>
        {opportunities.length === 0 ? <p className="muted text-sm">Noch keine Chance. Eine Chance kann direkt erfasst werden – ohne vollständiges Setup oder Qualifizierung (Fast-Track).</p> : (
          <table className="list">
            <thead><tr><th>Chance</th><th>Wofür</th><th>Status</th><th>Verantwortlich</th><th>Bestätigt</th><th>Geändert</th></tr></thead>
            <tbody>
              {opportunities.map((o) => (
                <tr key={o.id}>
                  <td><Link href={`/bedarfe/${o.id}`}>{o.title}</Link>{o.fastTrack && <span className="muted text-sm"> · direkte Anfrage</span>}</td>
                  <td className="text-sm">{chanceKindLabel[o.kind]}{o.roleId && roleName.get(o.roleId) ? ` · ${roleName.get(o.roleId)}` : ""}{o.headcount ? ` · ${o.headcount}×` : ""}{o.horizon ? ` · ${o.horizon}` : ""}</td>
                  <td><Status label={opportunityStatusLabel[o.status] ?? o.status} /></td>
                  <td>{name(o.ownerUserId)}</td>
                  <td>{o.confirmedAt ? fmtDate(o.confirmedAt) : <span className="muted">–</span>}</td>
                  <td>{fmtDate(o.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d.canEdit && (
          <details className="mt-3">
            <summary>Chance erfassen</summary>
            <form action={createOpportunityAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="setupId" value={id} />
              <input type="hidden" name="back" value={back} />
              <div><label className="label" htmlFor="opTitle">Titel</label><input id="opTitle" name="title" className="input" required minLength={3} placeholder="z. B. Testkoordination Migrationsteam" /></div>
              <div>
                <label className="label" htmlFor="opKind">Wofür – Art der Chance</label>
                <select id="opKind" name="kind" className="select" defaultValue="VERVE_EXPERTE">{chanceKindValues.map((k) => <option key={k} value={k}>{chanceKindLabel[k]}</option>)}</select>
              </div>
              <div>
                <label className="label" htmlFor="opRole">Standardrolle (optional)</label>
                <select id="opRole" name="roleId" className="select" defaultValue="">
                  <option value="">– noch offen –</option>
                  {roleGroups.map((g) => <optgroup key={g.family} label={g.label}>{g.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</optgroup>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label" htmlFor="opHeadcount">Anzahl (optional)</label><input id="opHeadcount" name="headcount" type="number" min={1} max={999} step={1} className="input" /></div>
                <div><label className="label" htmlFor="opHorizon">Zeithorizont (optional)</label><input id="opHorizon" name="horizon" className="input" placeholder="z. B. Q1 2027" maxLength={60} /></div>
              </div>
              <div>
                <label className="label" htmlFor="opSignal">Hervorgegangen aus Beobachtung (optional)</label>
                <select id="opSignal" name="signalId" className="select" defaultValue=""><option value="">– direkt erfasst –</option>{linkableSignals.map((s) => <option key={s.id} value={s.id}>{s.observation.slice(0, 80)}</option>)}</select>
              </div>
              <div className="sm:col-span-2"><label className="label" htmlFor="opNeed">Beschreibung in Kundensprache: was der Kunde erreichen will</label><textarea id="opNeed" name="needDescription" className="textarea" required minLength={10} rows={3} /></div>
              <div><label className="label" htmlFor="opTrigger">Konkreter Anlass (optional)</label><input id="opTrigger" name="trigger" className="input" /></div>
              <div className="flex flex-col gap-1 text-sm self-end">
                <label className="flex items-center gap-2"><input type="checkbox" name="anticipated" value="on" /> Antizipiert – vermutet aus Beobachtungen, vom Kunden noch nicht ausgesprochen</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="fastTrack" value="on" /> Direkte Anfrage (Fast-Track, Messstart jetzt)</label>
              </div>
              <div className="sm:col-span-2 flex flex-wrap items-start gap-3">
                <button className="btn" type="submit">Chance anlegen</button>
                <SuggestButton kind="CHANCE" setupId={id} fields={[{ name: "title", label: "Titel der Chance (kurz)" }, { name: "needDescription", label: "Beschreibung in Kundensprache: was der Kunde erreichen will" }, { name: "trigger", label: "Konkreter Anlass" }, { name: "kind", label: "Art der Chance", options: [...chanceKindValues] }, { name: "horizon", label: "Zeithorizont, z. B. Q1 2027" }]} />
              </div>
            </form>
          </details>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">3. Was haben wir als Nächstes vereinbart?</h2>
        {openActions.length === 0 ? <p className="muted text-sm">Keine offenen Aktionen.</p> : (
          <table className="list">
            <thead><tr><th>Aktion</th><th>Verantwortlich</th><th>Status</th><th>Fällig</th>{d.canEdit && <th></th>}</tr></thead>
            <tbody>
              {openActions.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.title}
                    {a.channel && <span className="muted text-sm"> · {actionChannelLabel[a.channel] ?? a.channel}{a.linkedinUrl && <> · <a href={a.linkedinUrl} target="_blank" rel="noopener noreferrer">Profil öffnen</a></>}</span>}
                    {a.agreement && <div className="muted text-sm">{a.agreement}</div>}
                    {a.result && <div className="muted text-sm">Stand: {a.result}</div>}
                  </td>
                  <td>{name(a.ownerUserId)}</td>
                  <td><Status label={actionStatusLabel[a.status] ?? a.status} /></td>
                  <td>{fmtDate(a.dueDate)}</td>
                  {d.canEdit && (
                    <td>
                      <form action={changeActionStatusAction} className="flex flex-wrap gap-1 items-end">
                        <input type="hidden" name="actionId" value={a.id} />
                        <input type="hidden" name="version" value={a.version} />
                        <input type="hidden" name="back" value={back} />
                        <input name="result" className="input" style={{ width: "11rem" }} placeholder="Ergebnis / Blocker" aria-label="Ergebnis oder Blocker" />
                        {a.status === "VORGESCHLAGEN" && a.ownerUserId === actor.userId && <button className="btn btn-small" name="status" value="ANGENOMMEN">Annehmen</button>}
                        {a.status !== "VORGESCHLAGEN" && <button className="btn btn-small" name="status" value="ERLEDIGT">Erledigt</button>}
                        {(a.status === "ANGENOMMEN" || a.status === "IN_ARBEIT") && <button className="btn btn-secondary btn-small" name="status" value="BLOCKIERT">Blockiert</button>}
                        <button className="btn btn-secondary btn-small" name="status" value="VERWORFEN">Verwerfen</button>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {doneActions.length > 0 && (
          <details className="mt-3"><summary className="text-sm">Erledigte Aktionen ({doneActions.length})</summary>
            <ul className="text-sm mt-2 space-y-1">{doneActions.map((a) => <li key={a.id}>{a.title} – {name(a.ownerUserId)} – Ergebnis: {a.result}</li>)}</ul>
          </details>
        )}
        {d.canEdit && (
          <details className="mt-3">
            <summary className="text-sm">Aktion vereinbaren</summary>
            <form action={createActionAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="setupId" value={d.setup.id} />
              <input type="hidden" name="back" value={back} />
              <div className="sm:col-span-2"><label className="label" htmlFor="actTitle">Was wird getan?</label><input id="actTitle" name="title" className="input" required minLength={3} /></div>
              <div className="sm:col-span-2">
                <label className="label" htmlFor="actOpp">Wofür – zahlt auf welche Chance ein?</label>
                <select id="actOpp" name="opportunityId" className="select" defaultValue={openOpportunities.length === 1 ? openOpportunities[0]!.id : ""}>
                  <option value="">– noch unklar –</option>
                  {openOpportunities.map((o) => <option key={o.id} value={o.id}>{o.title}{o.roleId && roleName.get(o.roleId) ? ` · ${roleName.get(o.roleId)}` : ""}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2"><label className="label" htmlFor="agreement">Vereinbarung / Kontext (optional)</label><input id="agreement" name="agreement" className="input" /></div>
              <div>
                <label className="label" htmlFor="ownerUserId">Wer übernimmt?</label>
                <select id="ownerUserId" name="ownerUserId" className="select" defaultValue={actor.userId}>
                  {allUsers.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                </select>
              </div>
              <div><label className="label" htmlFor="dueDate">Termin (optional)</label><input id="dueDate" name="dueDate" type="date" className="input" /></div>
              <div>
                <label className="label" htmlFor="signalId">Bezug zu Beobachtung (optional)</label>
                <select id="signalId" name="signalId" className="select" defaultValue="">
                  <option value="">–</option>
                  {openSignals.map((s) => <option key={s.id} value={s.id}>{s.observation.slice(0, 80)}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="actChannel">Kanal (optional)</label>
                <select id="actChannel" name="channel" className="select" defaultValue="">
                  <option value="">– nicht angegeben –</option>
                  {schema.actionChannelEnum.enumValues.map((v) => <option key={v} value={v}>{actionChannelLabel[v]}</option>)}
                </select>
              </div>
              <div><label className="label" htmlFor="actLinkedin">LinkedIn-Profillink (nur bei Kanal LinkedIn)</label><input id="actLinkedin" name="linkedinUrl" type="url" className="input" placeholder="https://www.linkedin.com/in/…" /></div>
              <div className="flex items-end gap-2">
                <label className="text-sm flex items-center gap-2"><input type="checkbox" name="agreedInConversation" value="true" /> Im Gespräch gemeinsam vereinbart (sonst: Vorschlag)</label>
              </div>
              <div className="sm:col-span-2"><button className="btn" type="submit">Aktion speichern</button></div>
            </form>
          </details>
        )}
      </section>

      {/* 4. Anregungen */}
      <section className="card">
        <h2 className="font-semibold mb-1">4. Welche Anregungen sind jetzt hilfreich?</h2>
        {!ai.enabled && <p className="muted text-sm">KI-Anbieter deaktiviert – keine automatischen Vorschläge. Offene Beobachtungen unten sind die manuelle Arbeitsliste.</p>}
        {ai.enabled && sugg.prominent.length === 0 && <p className="muted text-sm">Keine offenen Vorschläge. Vorschläge entstehen aus strukturierten Weekly-Notizen.</p>}
        {sugg.prominent.length > 0 && (
          <ul className="space-y-3">{sugg.prominent.map((x) => <SuggestionCard key={x.id} s={x} ownerName={x.proposedOwnerUserId ? sugg.userNames.get(x.proposedOwnerUserId) ?? null : null} canDecide={sugg.canDecide} back={back} users={allUsers} />)}</ul>
        )}
        {sugg.more.length > 0 && <p className="muted text-sm mt-2">{sugg.more.length} weitere Vorschläge im jeweiligen Weekly.</p>}
        {openQuestions.length > 0 && (
          <div className="mt-3">
            <h3 className="font-medium text-sm">Offene Fragen ({openQuestions.length})</h3>
            <ul className="text-sm list-disc ml-5">{openQuestions.map((q) => <li key={q.id}>{q.question}{q.decisionImpact && <span className="muted"> – Auswirkung: {q.decisionImpact}</span>}{q.possibleSource && <span className="muted"> – Weg: {q.possibleSource}</span>}</li>)}</ul>
          </div>
        )}
      </section>

      {/* Beobachtungen */}
      <section className="card">
        <h2 className="font-semibold mb-2">Beobachtungen ({openSignals.length} offen)</h2>
        {d.signals.length === 0 ? <p className="muted text-sm">Noch keine Beobachtungen erfasst.</p> : (
          <ul className="space-y-3">
            {d.signals.map((s) => {
              const relatedHandover = d.handovers.find((h) => h.subjectType === "SIGNAL" && h.subjectId === s.id && h.status === "ANGEFRAGT");
              return (
                <li key={s.id} className="border rounded-md p-3" style={{ borderColor: "var(--border)" }}>
                  <div className="flex flex-wrap gap-2 items-baseline">
                    <Status label={signalStatusLabel[s.status] ?? s.status} />
                    <span className="muted text-sm">{fmtDate(s.createdAt)} · erfasst von {name(s.createdBy)} · Prüfung: {s.ownerUserId ? name(s.ownerUserId) : "niemand"}</span>
                    {relatedHandover && <span className="muted text-sm">· Übergabe an {name(relatedHandover.receiverUserId)} angefragt</span>}
                  </div>
                  <p className="mt-1"><span className="muted text-sm">Beobachtung: </span>{s.observation}</p>
                  {s.relevanceHypothesis && <p className="text-sm"><span className="muted">Vermutung: </span>{s.relevanceHypothesis}</p>}
                  {s.usageLimit && <p className="text-sm"><span className="muted">Nutzungsgrenze: </span>{s.usageLimit}</p>}
                  {s.closedReason && <p className="text-sm"><span className="muted">Begründung: </span>{s.closedReason}</p>}
                  <p className="text-sm mt-1">{s.sourceId && d.sources.some((x) => x.id === s.sourceId) ? <Link href={`/quellen/${s.sourceId}`}>Quelle ansehen</Link> : <span className="muted">Quelle nicht in Ihrem Berechtigungsbereich</span>}</p>
                  {d.canEdit && s.status !== "BEENDET" && (
                    <div className="mt-2 flex flex-wrap gap-3 items-start">
                      {s.status === "NEU" && !relatedHandover && (
                        <form action={takeOverSignalAction}>
                          <input type="hidden" name="signalId" value={s.id} />
                          <input type="hidden" name="version" value={s.version} />
                          <input type="hidden" name="back" value={back} />
                          <button className="btn btn-small" type="submit">Prüfung selbst übernehmen</button>
                        </form>
                      )}
                      <form action={changeSignalStatusAction} className="flex flex-wrap gap-1 items-end">
                        <input type="hidden" name="signalId" value={s.id} />
                        <input type="hidden" name="version" value={s.version} />
                        <input type="hidden" name="back" value={back} />
                        <input name="closedReason" className="input" style={{ width: "14rem" }} placeholder="Begründung (bei Beenden/Zurückstellen)" aria-label="Begründung" />
                        {s.status === "PRUEFUNG_UEBERNOMMEN" && <button className="btn btn-secondary btn-small" name="status" value="IN_KLAERUNG">In Klärung</button>}
                        <button className="btn btn-secondary btn-small" name="status" value="ZURUECKGESTELLT">Zurückstellen</button>
                        <button className="btn btn-secondary btn-small" name="status" value="BEENDET">Beenden</button>
                      </form>
                      {!relatedHandover && others.length > 0 && (
                        <details>
                          <summary className="text-sm">Übergabe an eine andere Person</summary>
                          <form action={createHandoverAction} className="mt-2 grid sm:grid-cols-2 gap-2 max-w-3xl">
                            <input type="hidden" name="subjectType" value="SIGNAL" />
                            <input type="hidden" name="subjectId" value={s.id} />
                            <input type="hidden" name="back" value={back} />
                            <div>
                              <label className="label" htmlFor={`recv-${s.id}`}>Empfänger</label>
                              <select id={`recv-${s.id}`} name="receiverUserId" className="select" required defaultValue={d.setup.bdUserId && d.setup.bdUserId !== actor.userId ? d.setup.bdUserId : ""}>
                                <option value="" disabled>Bitte wählen …</option>
                                {others.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                              </select>
                            </div>
                            <div><label className="label" htmlFor={`due-${s.id}`}>Termin (optional)</label><input id={`due-${s.id}`} name="dueDate" type="date" className="input" /></div>
                            <div className="sm:col-span-2"><label className="label" htmlFor={`ctx-${s.id}`}>Kontext</label><input id={`ctx-${s.id}`} name="context" className="input" required defaultValue={`Beobachtung aus dem Setup „${d.setup.name}“.`} /></div>
                            <div><label className="label" htmlFor={`prov-${s.id}`}>Was ist belegt?</label><input id={`prov-${s.id}`} name="proven" className="input" defaultValue={s.observation} /></div>
                            <div><label className="label" htmlFor={`open-${s.id}`}>Was bleibt offen?</label><input id={`open-${s.id}`} name="open" className="input" defaultValue={s.relevanceHypothesis ?? ""} /></div>
                            <div><label className="label" htmlFor={`use-${s.id}`}>Was darf verwendet werden?</label><input id={`use-${s.id}`} name="allowedUse" className="input" defaultValue={s.usageLimit ?? ""} /></div>
                            <div><label className="label" htmlFor={`fb-${s.id}`}>Rückmeldung über</label><input id={`fb-${s.id}`} name="feedbackChannel" className="input" placeholder="z. B. nächstes Weekly" /></div>
                            <div className="sm:col-span-2"><label className="label" htmlFor={`resp-${s.id}`}>Welche konkrete Verantwortung soll übernommen werden?</label><input id={`resp-${s.id}`} name="responsibility" className="input" required minLength={5} placeholder="z. B. Klären, wer die Kapazitätsplanung koordiniert" /></div>
                            <div className="sm:col-span-2"><button className="btn btn-small" type="submit">Übergabe anfragen</button></div>
                          </form>
                        </details>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {d.canEdit && (
          <details className="mt-4" open={d.signals.length === 0}>
            <summary>Beobachtung erfassen</summary>
            <form action={captureObservationAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="setupId" value={d.setup.id} />
              <div className="sm:col-span-2"><label className="label" htmlFor="observation">Sichere Beobachtung (was wurde tatsächlich gesagt/gesehen?)</label><textarea id="observation" name="observation" className="textarea" required minLength={5} /></div>
              <div className="sm:col-span-2"><label className="label" htmlFor="relevanceHypothesis">Vermutung / mögliche Bedeutung (getrennt von der Beobachtung, optional)</label><input id="relevanceHypothesis" name="relevanceHypothesis" className="input" /></div>
              <div><label className="label" htmlFor="usageLimit">Nutzungsgrenze (optional)</label><input id="usageLimit" name="usageLimit" className="input" placeholder="z. B. nicht als Chance gegenüber Kunde formulieren" /></div>
              <div>
                <label className="label" htmlFor="sourceAccessClass">Wer darf die Originalnotiz sehen?</label>
                <select id="sourceAccessClass" name="sourceAccessClass" className="select" defaultValue="SETUP">
                  {schema.accessClassEnum.enumValues.map((v) => <option key={v} value={v}>{accessClassLabel[v]}</option>)}
                </select>
              </div>
              <div><label className="label" htmlFor="sourceTitle">Anlass / Quelle (optional)</label><input id="sourceTitle" name="sourceTitle" className="input" placeholder="z. B. Weekly 18.09." /></div>
              <div><label className="label" htmlFor="sourceTime">Zeitpunkt der Beobachtung (optional)</label><input id="sourceTime" name="sourceTime" type="datetime-local" className="input" /></div>
              <div className="sm:col-span-2"><button className="btn" type="submit">Beobachtung speichern</button></div>
            </form>
          </details>
        )}
      </section>

      {/* Übergaben */}
      {d.handovers.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Übergaben ({openHandovers.length} offen)</h2>
          <table className="list">
            <thead><tr><th>Verantwortung</th><th>Von → An</th><th>Status</th><th>Rückmeldung</th><th></th></tr></thead>
            <tbody>
              {d.handovers.map((h) => (
                <tr key={h.id}>
                  <td>{h.responsibility}<div className="muted text-sm">{h.context}</div></td>
                  <td>{name(h.senderUserId)} → {name(h.receiverUserId)}</td>
                  <td><Status label={handoverStatusLabel[h.status] ?? h.status} /></td>
                  <td>{h.responseNote ?? "–"}</td>
                  <td>
                    {h.status === "ANGENOMMEN" && (h.receiverUserId === actor.userId || h.senderUserId === actor.userId) && (
                      <form action={respondHandoverAction} className="flex gap-1 items-end">
                        <input type="hidden" name="handoverId" value={h.id} />
                        <input type="hidden" name="version" value={h.version} />
                        <input type="hidden" name="back" value={back} />
                        <input type="hidden" name="decision" value="ABSCHLIESSEN" />
                        <input name="responseNote" className="input" style={{ width: "12rem" }} placeholder="Ergebnis" required aria-label="Ergebnis der Übergabe" />
                        <button className="btn btn-small" type="submit">Abschließen</button>
                      </form>
                    )}
                    {h.status === "ANGEFRAGT" && h.receiverUserId === actor.userId && <Link href="/meine-arbeit" className="text-sm">In „Meine Arbeit“ beantworten</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Quellen */}
      {/* Unterstützungsaufträge (11.1, F13) */}
      <section className="card">
        <h2 className="font-semibold mb-2">Unterstützung durch Principal/CEO ({openSupport.length} offen)</h2>
        <p className="muted text-sm mb-2">Ein Unterstützungsauftrag ist begrenzt und konkret (z. B. „Kontakt zu Frau X herstellen“, „Angebotsentwurf gegenlesen“). Die operative Fallverantwortung bleibt beim BD.</p>
        {support.length === 0 ? <p className="muted text-sm">Keine Unterstützungsaufträge zu diesem Setup.</p> : (
          <ul className="space-y-2">
            {support.map((s) => (
              <li key={s.id} className="border rounded-md p-3 text-sm" style={{ borderColor: "var(--border)" }}>
                <div className="flex flex-wrap gap-2 items-baseline"><strong>{s.task}</strong><Status label={supportStatusLabel[s.status] ?? s.status} /><span className="muted">{s.requesterName} → {s.addresseeName}{s.dueDate && ` · bis ${fmtDate(s.dueDate)}`}</span></div>
                {s.context && <p className="muted mt-1">{s.context}</p>}
                {s.responseNote && <p className="mt-1">Rückmeldung: {s.responseNote}</p>}
                {s.result && <p className="mt-1">Ergebnis: {s.result}</p>}
                {(s.isAddressee || s.isRequester) && (s.status === "ANGEFRAGT" || s.status === "ANGENOMMEN") && (
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
        {d.canEdit && leaders.length > 0 && (
          <details className="mt-3">
            <summary>Unterstützung anfragen</summary>
            <form action={createSupportRequestAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="setupId" value={id} />
              <input type="hidden" name="back" value={back} />
              <div className="sm:col-span-2"><label className="label" htmlFor="srTask">Konkreter Auftrag</label><input id="srTask" name="task" className="input" required minLength={10} placeholder="z. B. Kontakt zur Bereichsleitung Einkauf herstellen" /></div>
              <div>
                <label className="label" htmlFor="srAddressee">An</label>
                <select id="srAddressee" name="addresseeUserId" className="select" required>{leaders.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
              </div>
              <div><label className="label" htmlFor="srDue">Bis (optional)</label><input id="srDue" name="dueDate" type="date" className="input" /></div>
              <div className="sm:col-span-2"><label className="label" htmlFor="srContext">Kontext (was liegt vor, was wird gebraucht)</label><textarea id="srContext" name="context" className="textarea" rows={2} /></div>
              <div className="sm:col-span-2"><button className="btn" type="submit">Unterstützung anfragen</button></div>
            </form>
          </details>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Quellen</h2>
        {d.sources.length === 0 ? <p className="muted text-sm">Keine Quellen in Ihrem Berechtigungsbereich.</p> : (
          <table className="list">
            <thead><tr><th>Titel</th><th>Typ</th><th>Quellenzeit</th><th>Inhaber</th><th>Zugriff</th></tr></thead>
            <tbody>
              {d.sources.map((s) => (
                <tr key={s.id}>
                  <td><Link href={`/quellen/${s.id}`}>{s.title}</Link></td>
                  <td>{sourceTypeLabel[s.type] ?? s.type}</td>
                  <td>{fmtDateTime(s.sourceTime)}</td>
                  <td>{name(s.ownerUserId)}</td>
                  <td>{accessClassLabel[s.accessClass]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d.hiddenSourceCount > 0 && <p className="muted text-sm mt-2">{d.hiddenSourceCount} weitere Quelle(n) sind für Ihre Rolle nicht einsehbar.</p>}
        {d.canEdit && (
          <form action={startInterviewAction} className="mt-4 flex flex-wrap items-center gap-3">
            <input type="hidden" name="kind" value="SETUP_ERGAENZUNG" />
            <input type="hidden" name="setupId" value={d.setup.id} />
            <Link href={`/setups/${d.setup.id}?assistent=interview`} className="btn">Mit dem Assistenten ergänzen (Dialog)</Link>
            <button className="btn btn-secondary" type="submit">Interview zu diesem Setup führen</button>
            <span className="muted text-sm">Der Assistent fragt, was noch fehlt (Personen, Entscheidungsweg, Chance, nächste Schritte) und legt Vorschlagskarten für dieses Setup vor – übernommen wird nur, was Sie anklicken.</span>
          </form>
        )}
        {d.canEdit && (
          <details className="mt-4">
            <summary>Dokument hochladen (PDF, Word, Excel, CSV, Text, E-Mail)</summary>
            <form action={uploadDocumentAction} encType="multipart/form-data" className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="setupId" value={d.setup.id} />
              <div className="sm:col-span-2"><label className="label" htmlFor="file">Datei (max. {maxUploadMb} MB)</label><input id="file" name="file" type="file" className="input" required accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.eml,.json" /></div>
              <div><label className="label" htmlFor="docTitle">Titel (optional, sonst Dateiname)</label><input id="docTitle" name="title" className="input" maxLength={200} /></div>
              <div>
                <label className="label" htmlFor="docAccessClass">Wer darf das Dokument sehen?</label>
                <select id="docAccessClass" name="accessClass" className="select" defaultValue="SETUP">
                  {schema.accessClassEnum.enumValues.map((v) => <option key={v} value={v}>{accessClassLabel[v]}</option>)}
                </select>
              </div>
              <div><label className="label" htmlFor="docSourceTime">Datum des Dokuments (optional)</label><input id="docSourceTime" name="sourceTime" type="datetime-local" className="input" /></div>
              <p className="muted text-sm sm:col-span-2">Der Text wird auf dem Server extrahiert und als Quelle geführt; die Datei bleibt zum Nachlesen gespeichert. {ai.enabled ? "Auf der Quellenseite können Sie daraus KI-Vorschläge erzeugen lassen." : "KI ist deaktiviert; das Dokument ist trotzdem als Quelle nutzbar."}</p>
              <div className="sm:col-span-2"><button className="btn" type="submit">Dokument hochladen</button></div>
            </form>
          </details>
        )}
      </section>
    </div>
  );
}
