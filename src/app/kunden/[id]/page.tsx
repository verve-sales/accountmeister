import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { getAccount } from "@/modules/accounts/service";
import { listSetupsForAccount } from "@/modules/setups/service";
import { listOpportunitiesForAccount } from "@/modules/opportunities/service";
import { canCreateSetup, canReassignResponsibility, loadSetupContext } from "@/modules/identity/authz";
import { analyzeSetup, STAGES, stageLabel } from "@/modules/strategy/analysis";
import { ProcessStepper } from "@/components/ProcessStepper";
import { canDeleteAccount } from "@/modules/accounts/deletion";
import { DomainError } from "@/lib/errors";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { accountStatusLabel, fmtDate, setupStatusLabel, visibilityLabel, contributionLabel, opportunityStatusLabel } from "@/lib/labels";
import { createSetupAction } from "../../actions";
import { listPeopleForAccount } from "@/modules/people/service";
import { relationshipStateLabel, priorityKindLabel, priorityStatusLabel } from "@/lib/labels";
import { buildAccountPlan, canEditAccountPlan, listAccountPlanSnapshots } from "@/modules/accountplan/service";
import { AccountPlanView } from "@/components/AccountPlanView";
import { chanceKindLabel } from "@/modules/ai/schemas";
import { listRoles } from "@/modules/roles/catalog";
import { SuggestButton } from "@/components/SuggestButton";
import { changePriorityAction, createPriorityAction, reassignAccountBdAction, refreshCompanyResearchAction, saveAccountPlanSnapshotAction, setAccountDormantAction } from "../../actions";
import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { getCompanyResearch, type CompanyFact } from "@/modules/research/service";
import { listPlaybooks, listRuns } from "@/modules/playbooks/service";
import { PlaybookRuns } from "@/components/PlaybookRuns";

export default async function KundePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
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
  const setups = await listSetupsForAccount(actor, id);
  const opportunities = await listOpportunitiesForAccount(actor, id);
  const people = await listPeopleForAccount(actor, id);
  const roleNames = new Map((await listRoles(actor.workspaceId, { includeInactive: true })).map((r) => [r.id, r.name]));
  const [plan, snapshots, mayEditPlan] = await Promise.all([buildAccountPlan(actor, id), listAccountPlanSnapshots(actor, id), canEditAccountPlan(actor, id)]);
  const research = await getCompanyResearch(actor, id);
  const back = `/kunden/${id}`;
  const mayCreate = canCreateSetup(actor, account);
  const mayDelete = canDeleteAccount(actor, account);
  const mayReassign = canReassignResponsibility(actor, account);
  const bdUsers = mayCreate || mayReassign
    ? [...new Map((await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users).innerJoin(schema.roleAssignments, eq(schema.roleAssignments.userId, schema.users.id)).where(eq(schema.roleAssignments.role, "BD"))).map((u) => [u.id, u])).values()]
    : [];

  // Prozessstufe je Setup (Etappe „Wo stehen wir?“) – aus vorhandenen Zuständen abgeleitet, nichts Neues erfasst.
  const analyses = await Promise.all(
    setups.map(async (s) => {
      const ctx = await loadSetupContext(actor, s.id);
      return ctx ? { setupId: s.id, analysis: await analyzeSetup(actor, ctx) } : null;
    }),
  );
  const analysisBySetup = new Map(analyses.filter((a): a is NonNullable<typeof a> => !!a).map((a) => [a.setupId, a.analysis]));
  const furthestStage = [...analysisBySetup.values()].sort((a, b) => STAGES.indexOf(b.stage) - STAGES.indexOf(a.stage))[0] ?? null;
  const [runs, accountPlaybooks, activeUsers] = await Promise.all([
    listRuns(actor, { accountId: id }),
    listPlaybooks(actor, { scope: "ACCOUNT", activeOnly: true }),
    db.query.users.findMany({ where: eq(schema.users.status, "ACTIVE"), orderBy: (u, { asc }) => [asc(u.displayName)] }),
  ]);
  const mayStartPlaybook = mayReassign || mayCreate;
  const currentBdName = account.responsibleBdUserId
    ? (bdUsers.find((u) => u.id === account.responsibleBdUserId)?.displayName ?? (await db.query.users.findFirst({ where: eq(schema.users.id, account.responsibleBdUserId) }))?.displayName ?? "?")
    : null;

  return (
    <div className="space-y-6">
      <p className="text-sm"><Link href="/kunden">Kunden</Link> › {account.name}</p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{account.name}</h1>
        {account.status === "ARCHIVED" && <Status label={accountStatusLabel.ARCHIVED!} />}
        {mayDelete && <Link href={`/kunden/${account.id}/loeschen`} className="muted text-sm ml-auto">Kunde archivieren oder löschen</Link>}
      </div>
      {account.status === "ARCHIVED" && <p className="text-sm" style={{ background: "#fdf6ec", border: "1px solid var(--border)", borderRadius: 8, padding: ".5rem .8rem" }}>Dieser Kunde ist archiviert. Alles bleibt erhalten; <Link href={`/kunden/${account.id}/loeschen`}>wiederherstellen oder endgültig löschen</Link>.</p>}
      {furthestStage && (
        <section className="card">
          <h2 className="font-semibold mb-2">Wo stehen wir?</h2>
          <ProcessStepper steps={STAGES.map((s) => ({ key: s, label: stageLabel[s] }))} currentKey={furthestStage.stage} note={furthestStage.nextStep} />
          {setups.length > 1 && <p className="muted text-xs mt-2">Zeigt das am weitesten fortgeschrittene Setup ({furthestStage.setupName}); jedes Setup hat seine eigene Stufe – siehe Tabelle unten.</p>}
        </section>
      )}
      <Feedback params={sp} />

      {mayReassign && (
        <section className="card">
          <h2 className="font-semibold mb-2">Zuständigkeit</h2>
          <p className="text-sm mb-2">Zuständiger BD: {currentBdName ?? <span className="muted">Zuordnung offen</span>}</p>
          <form action={reassignAccountBdAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="accountId" value={account.id} />
            <input type="hidden" name="version" value={account.version} />
            <div>
              <label className="label" htmlFor="reassignBd">Zuständigen BD umstellen</label>
              <select id="reassignBd" name="responsibleBdUserId" className="select" required defaultValue="">
                <option value="" disabled>Bitte wählen …</option>
                {bdUsers.filter((u) => u.id !== account.responsibleBdUserId).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </select>
            </div>
            <button className="btn btn-secondary" type="submit">Umstellen</button>
          </form>
          <p className="muted text-xs mt-2">Als Principal, CEO oder aktuell zuständiger BD können Sie die Kundenzuständigkeit jederzeit umstellen – unabhängig von der ursprünglichen Zuordnung.</p>
          {account.status !== "ARCHIVED" && (
            <form action={setAccountDormantAction} className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <input type="hidden" name="accountId" value={account.id} />
              <input type="hidden" name="dormant" value={account.status === "DORMANT" ? "false" : "true"} />
              <span className="muted">Status: {accountStatusLabel[account.status] ?? account.status}.</span>
              <button className="btn btn-secondary btn-small" type="submit">{account.status === "DORMANT" ? "Wieder als aktiv führen" : "Als ruhend markieren"}</button>
            </form>
          )}
        </section>
      )}

      {account.status === "DORMANT" && <p className="text-sm" style={{ background: "var(--warn-soft)", border: "1px solid var(--border)", borderRadius: 8, padding: ".5rem .8rem" }}>Dieser Kunde ruht. Mit dem Vorgehen „Altkunden-Reaktivierung“ (unten) wird er wieder aktiv angegangen.</p>}

      <PlaybookRuns
        runs={runs}
        back={back}
        users={activeUsers.map((u) => ({ id: u.id, displayName: u.displayName }))}
        start={mayStartPlaybook && account.status !== "ARCHIVED" ? { playbooks: accountPlaybooks, hidden: { accountId: account.id }, setups: setups.filter((x) => x.status !== "ARCHIVIERT").map((x) => ({ id: x.id, name: x.name })), defaultNewSetupName: `Reaktivierung ${new Date().getFullYear()}`, defaultOwnerId: account.responsibleBdUserId } : null}
      />

      {/* Öffentliche Unternehmensrecherche (Etappe 16): eng begrenzte Ausnahme – nur öffentliche Firmendaten, nie Personennamen */}
      <section className="card">
        <div className="flex flex-wrap items-baseline gap-3 mb-2">
          <h2 className="font-semibold">Öffentliche Informationen zum Unternehmen</h2>
          <form action={refreshCompanyResearchAction} className="ml-auto">
            <input type="hidden" name="accountId" value={account.id} />
            <button className="btn btn-secondary btn-small" type="submit">{research.latest ? "Aktualisieren" : "Recherche starten"}</button>
          </form>
        </div>
        <p className="muted text-xs mb-2">Ausschließlich öffentliche, unternehmensbezogene Angaben mit Quelle (Branche, Sitz, Größenordnung, öffentliche Meldungen) – nie zu benannten Einzelpersonen. Fixture-Daten (fiktiv): kein echter Internetzugriff, bis ein Suchdienst konfiguriert ist.</p>
        {!research.latest ? (
          <p className="muted text-sm">Noch keine Recherche gestartet.</p>
        ) : (
          <>
            {(research.latest.facts as CompanyFact[]).length === 0 ? (
              <p className="muted text-sm">{research.latest.note}</p>
            ) : (
              <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                {(research.latest.facts as CompanyFact[]).map((f, i) => (
                  <div key={i}>
                    <dt className="muted">{f.label}</dt>
                    <dd>
                      {f.value}
                      <span className="muted"> · {f.sourceUrl ? <a href={f.sourceUrl} target="_blank" rel="noopener noreferrer">{f.sourceLabel}</a> : f.sourceLabel}{f.asOf ? ` (Stand ${f.asOf})` : ""}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            <p className="muted text-xs mt-2">{research.latest.note} Zuletzt abgerufen {fmtDate(research.latest.fetchedAt)}.</p>
          </>
        )}
      </section>

      {/* Wofür (E-045): worauf die Arbeit bei diesem Kunden hinausläuft – zuerst */}
      <section className="card">
        <h2 className="font-semibold mb-2">Wofür – Chancen ({opportunities.filter((o) => o.status !== "BEENDET" && o.status !== "ZURUECKGESTELLT").length} aktiv)</h2>
        {opportunities.length === 0 ? (
          <p className="text-sm" style={{ color: "#8a6d1f" }}>Noch keine Chance benannt. Worauf läuft es bei diesem Kunden hinaus – Verve-Experte in einer Standardrolle, Freelancer-Experte oder Ausschreibung? Chancen entstehen im Setup („Chance erfassen“) oder über den Assistenten.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Chance</th><th>Wofür</th><th>Setup</th><th>Reifegrad</th><th>Horizont</th></tr></thead>
            <tbody>
              {opportunities.filter((o) => o.status !== "BEENDET").map((o) => (
                <tr key={o.id}>
                  <td><Link href={`/bedarfe/${o.id}`}>{o.title}</Link></td>
                  <td className="text-sm">{chanceKindLabel[o.kind]}{o.roleId && roleNames.get(o.roleId) ? ` · ${roleNames.get(o.roleId)}` : ""}{o.headcount ? ` · ${o.headcount}×` : ""}</td>
                  <td><Link href={`/setups/${o.setupId}`}>{o.setupName}</Link></td>
                  <td><Status label={opportunityStatusLabel[o.status] ?? o.status} /></td>
                  <td>{o.horizon ?? <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted text-xs mt-2">Jede Chance hat einen eigenen Reifegrad; es gibt keinen zusammengefassten Pipelinestatus je Kunde. Beobachtungen, Fragen und Aktionen zahlen auf Chancen ein.</p>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Überblick – Accountplan</h2>
        <AccountPlanView plan={plan} live>
          {mayEditPlan && (
            <div className="grid lg:grid-cols-2 gap-6 mt-2">
              <details>
                <summary className="text-sm">Ausbau-Vorhaben vorschlagen (Verlängern, Ausweiten, Vertiefen, Übertragen)</summary>
                <form action={createPriorityAction} className="mt-2 grid sm:grid-cols-2 gap-2">
                  <input type="hidden" name="accountId" value={account.id} />
                  <div className="sm:col-span-2"><label className="label" htmlFor="prTitle">Vorhaben</label><input id="prTitle" name="title" className="input" required minLength={3} placeholder="z. B. Testkoordination im Migrationsteam anbieten" /></div>
                  <div>
                    <label className="label" htmlFor="prKind">Art</label>
                    <select id="prKind" name="kind" className="select" defaultValue="AUSWEITEN">{schema.priorityKindEnum.enumValues.map((v) => <option key={v} value={v}>{priorityKindLabel[v]}</option>)}</select>
                  </div>
                  <div>
                    <label className="label" htmlFor="prSetup">Bezug zu Setup (optional)</label>
                    <select id="prSetup" name="setupId" className="select" defaultValue=""><option value="">–</option>{setups.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                  </div>
                  <div><label className="label" htmlFor="prRank">Rang (1 = höchste)</label><input id="prRank" name="rank" type="number" min={1} max={999} defaultValue={plan.priorities.length + 1} className="input" /></div>
                  <div><label className="label" htmlFor="prGoal">Zielbezug (Text, bis Ziele modelliert sind)</label><input id="prGoal" name="goalReference" className="input" /></div>
                  <div className="sm:col-span-2"><label className="label" htmlFor="prWhy">Begründung</label><input id="prWhy" name="rationale" className="input" /></div>
                  <div className="sm:col-span-2"><label className="label" htmlFor="prPre">Voraussetzungen</label><input id="prPre" name="prerequisites" className="input" placeholder="Zeit, Zugang, Freigaben …" /></div>
                  <div className="sm:col-span-2 flex flex-wrap items-start gap-3">
                    <button className="btn btn-small" type="submit">Als Vorschlag aufnehmen</button>
                    <SuggestButton kind="VORHABEN" accountId={account.id} fields={[{ name: "title", label: "Vorhaben – ein Satz, was bei diesem Kunden als Nächstes erreicht werden soll" }, { name: "kind", label: "Art des Vorhabens", options: [...schema.priorityKindEnum.enumValues] }, { name: "rationale", label: "Begründung aus der Lage" }, { name: "prerequisites", label: "Voraussetzungen (Zeit, Zugang, Freigaben)" }]} />
                  </div>
                </form>
              </details>
              <details>
                <summary className="text-sm">Priorität ändern (Zustimmung, Zurückstellen, Rang)</summary>
                {plan.priorities.length === 0 ? <p className="muted text-sm mt-2">Noch keine Vorhaben.</p> : (
                  <ul className="mt-2 space-y-2">
                    {plan.priorities.map((p) => (
                      <li key={p.id}>
                        <form action={changePriorityAction} className="flex flex-wrap gap-1 items-end text-sm">
                          <input type="hidden" name="priorityId" value={p.id} />
                          <input type="hidden" name="version" value={p.version} />
                          <input type="hidden" name="back" value={back} />
                          <span className="grow min-w-48">{p.title} <span className="muted">({priorityStatusLabel[p.status]})</span></span>
                          <input name="rank" type="number" min={1} max={999} defaultValue={p.rank} className="input" style={{ width: "4.5rem" }} aria-label="Rang" />
                          <input name="deferredReason" className="input" style={{ width: "12rem" }} placeholder="Grund (bei Zurückstellen)" aria-label="Grund für Zurückstellen" />
                          {(p.status === "VORGESCHLAGEN" || p.status === "ZURUECKGESTELLT") && <button className="btn btn-small" name="status" value="VEREINBART">Zustimmen</button>}
                          {(p.status === "VORGESCHLAGEN" || p.status === "VEREINBART") && <button className="btn btn-secondary btn-small" name="status" value="ZURUECKGESTELLT">Zurückstellen</button>}
                          {p.status === "VEREINBART" && <button className="btn btn-secondary btn-small" name="status" value="ERREICHT">Erreicht</button>}
                          {p.status !== "ERREICHT" && p.status !== "VERWORFEN" && <button className="btn btn-secondary btn-small" name="status" value="VERWORFEN">Verwerfen</button>}
                          <button className="btn btn-secondary btn-small" type="submit">Rang speichern</button>
                        </form>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </div>
          )}
        </AccountPlanView>
        <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <h3 className="font-medium mb-1">Gespeicherte Stände ({snapshots.length})</h3>
          {snapshots.length === 0 ? <p className="muted text-sm">Noch kein gespeicherter Review-Stand.</p> : (
            <ul className="text-sm space-y-1">{snapshots.map((s) => <li key={s.id}><Link href={`/kunden/${account.id}/staende/${s.id}`}>{s.title}</Link> · {s.confirmedByName} · {new Date(s.confirmedAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" })}{s.note && <span className="muted"> – {s.note}</span>}</li>)}</ul>
          )}
          {mayEditPlan && (
            <form action={saveAccountPlanSnapshotAction} className="mt-2 flex flex-wrap gap-2 items-end">
              <input type="hidden" name="accountId" value={account.id} />
              <div><label className="label" htmlFor="snapTitle">Aktuellen Stand speichern als</label><input id="snapTitle" name="title" className="input" required minLength={3} placeholder="z. B. Kundenreview KW 40" /></div>
              <div className="grow"><label className="label" htmlFor="snapNote">Notiz (optional)</label><input id="snapNote" name="note" className="input" /></div>
              <button className="btn btn-small" type="submit">Stand speichern</button>
            </form>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Projektsetups ({setups.length})</h2>
        {setups.length === 0 ? (
          <p className="muted text-sm">Noch kein Setup. Ein Setup braucht nur Kunde, Namen und einen Kontextsatz – oder bleibt bewusst Entwurf.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Setup</th><th>Status</th><th>Prozessstufe</th><th>Sichtbarkeit</th><th>BD</th><th>Geändert</th></tr></thead>
            <tbody>
              {setups.map((s) => (
                <tr key={s.id}>
                  <td><Link href={`/setups/${s.id}`}>{s.name}</Link>{s.contextNote && <div className="muted text-sm">{s.contextNote}</div>}</td>
                  <td><Status label={setupStatusLabel[s.status] ?? s.status} /></td>
                  <td>
                    {analysisBySetup.get(s.id) ? (
                      <ProcessStepper steps={STAGES.map((st) => ({ key: st, label: stageLabel[st] }))} currentKey={analysisBySetup.get(s.id)!.stage} variant="compact" />
                    ) : (
                      <span className="muted text-sm">–</span>
                    )}
                  </td>
                  <td>{visibilityLabel[s.visibility]}</td>
                  <td>{s.bdUserId ? "zugeordnet" : <Status label="Zuordnung offen" />}</td>
                  <td>{fmtDate(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Personen & Zugang ({people.length})</h2>
        {people.length === 0 ? <p className="muted text-sm">Noch keine Personen erfasst. Personen werden im jeweiligen Setup gepflegt.</p> : (
          <table className="list">
            <thead><tr><th>Person</th><th>Funktion</th><th>Beziehungen (Halter · Stand)</th></tr></thead>
            <tbody>
              {people.map(({ person, currentFunction, relationships }) => (
                <tr key={person.id}>
                  <td>{person.displayName}</td>
                  <td>{currentFunction?.functionTitle ?? <span className="muted">unbekannt</span>}</td>
                  <td className="text-sm">{relationships.length === 0 ? <span className="muted">keine dokumentiert</span> : relationships.map((r) => <div key={r.id}>{r.holderName} · <Status label={relationshipStateLabel[r.state] ?? r.state} /></div>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {setups.length > 0 && <p className="muted text-sm mt-2">Pflege je Setup: {setups.map((s, i) => <span key={s.id}>{i > 0 && ", "}<Link href={`/setups/${s.id}/personen`}>{s.name}</Link></span>)}</p>}
      </section>

      {mayCreate && (
        <details className="card" open={setups.length === 0}>
          <summary>Setup anlegen</summary>
          <form action={createSetupAction} className="mt-3 grid sm:grid-cols-2 gap-3">
            <input type="hidden" name="accountId" value={account.id} />
            <div className="sm:col-span-2"><label className="label" htmlFor="name">Verständlicher Setup-Name</label><input id="name" name="name" className="input" required minLength={3} placeholder="z. B. Plattformteam" /></div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="contextNote">Kontextsatz (optional – leer lassen für bewussten Entwurf)</label>
              <textarea id="contextNote" name="contextNote" className="textarea" placeholder="Was läuft hier? Ein Satz genügt." />
            </div>
            <div>
              <label className="label" htmlFor="bdUserId">Zuständiger BD</label>
              <select id="bdUserId" name="bdUserId" className="select" defaultValue="">
                <option value="">– Zuordnung offen (erscheint im Eingang) –</option>
                {bdUsers.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="visibility">Sichtbarkeit</label>
              <select id="visibility" name="visibility" className="select" defaultValue="MITGLIEDER">
                {schema.setupVisibilityEnum.enumValues.map((v) => <option key={v} value={v}>{visibilityLabel[v]}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="creatorContribution">Mein vereinbarter Beitrag</label>
              <select id="creatorContribution" name="creatorContribution" className="select" defaultValue="ANKER_KONTEXT">
                {schema.membershipContributionEnum.enumValues.map((v) => <option key={v} value={v}>{contributionLabel[v]}</option>)}
              </select>
            </div>
            <div><label className="label" htmlFor="contributionNote">Erläuterung zum Beitrag (sachlich, optional)</label><input id="contributionNote" name="contributionNote" className="input" placeholder="z. B. Kontext beitragen, keine Ansprache neuer Personen" /></div>
            <div className="sm:col-span-2 flex flex-wrap items-start gap-3">
              <button className="btn" type="submit">Setup anlegen</button>
              <SuggestButton kind="SETUP" accountId={account.id} fields={[{ name: "name", label: "Verständlicher Setup-Name (Team, Bereich oder Vorhaben beim Kunden)" }, { name: "contextNote", label: "Kontextsatz: Was läuft hier beim Kunden?" }, { name: "visibility", label: "Sichtbarkeit", options: [...schema.setupVisibilityEnum.enumValues] }]} />
            </div>
          </form>
        </details>
      )}
    </div>
  );
}
