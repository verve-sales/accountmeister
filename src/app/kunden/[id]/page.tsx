import Link from "next/link";
import { Term } from "@/components/Term";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { getAccount } from "@/modules/accounts/service";
import { listSetupsForAccount } from "@/modules/setups/service";
import { listOpportunitiesForAccount } from "@/modules/opportunities/service";
import { canCreateSetup, canReassignResponsibility } from "@/modules/identity/authz";
import { isReadOnlyFor, isSalesOps } from "@/modules/identity/actor";
import { ChancenUebersicht } from "@/components/ChancenUebersicht";
import { topCandidatesForOpportunities } from "@/modules/staffing/service";
import { canDeleteAccount } from "@/modules/accounts/deletion";
import { DomainError } from "@/lib/errors";
import { Feedback } from "@/components/Feedback";
import { EingangCard } from "@/components/EingangCard";
import { Status } from "@/components/Status";
import { orgTypeLabel } from "@/lib/labels";
import { hasRoleForAccountWrite } from "@/modules/identity/authz";
import { accountStatusLabel, fmtDate, setupStatusLabel, visibilityLabel, contributionLabel, opportunityStatusLabel } from "@/lib/labels";
import { createInitiativeAction, createSetupAction, linkChanceInitiativeAction, setAccountKeysAction, setAccountOrgTypeAction } from "../../actions";
import { suggestedDomains } from "@/modules/accounts/keys";
import { listCardsByInitiative } from "@/modules/suggestions/service";
import { listPeopleForAccount } from "@/modules/people/service";
import { relationshipStateLabel, priorityKindLabel, priorityStatusLabel } from "@/lib/labels";
import { buildAccountPlan, canEditAccountPlan, listAccountPlanSnapshots } from "@/modules/accountplan/service";
import { AccountPlanView } from "@/components/AccountPlanView";
import { SuggestButton } from "@/components/SuggestButton";
import { changePriorityAction, createPriorityAction, reassignAccountBdAction, refreshCompanyResearchAction, saveAccountPlanSnapshotAction, setAccountDormantAction } from "../../actions";
import { db, schema } from "@/db/client";
import { and, eq, inArray } from "drizzle-orm";
import { getCompanyResearch, type CompanyFact } from "@/modules/research/service";
import { listPlaybooks, listRuns, listSalesOpsUsers } from "@/modules/playbooks/service";
import { PlaybookRuns } from "@/components/PlaybookRuns";
import { HealthBadge } from "@/components/HealthBadge";
import { computeHealthFor } from "@/modules/health/service";
import { canMaintainAgenda, listInitiatives } from "@/modules/agenda/service";
import { listSosForAccount } from "@/modules/sos/service";
import { KundenAgenda, Beschaffung } from "@/components/KundenAgenda";
import { SosPanel } from "@/components/SosPanel";
import { Comments, WorkBlock } from "@/components/Work";
import { Beschaffungsprofil } from "@/components/Beschaffungsprofil";
import { getConfig } from "@/lib/config";

type Bucket = "grundlagen" | "strategie" | "operativ";

export default async function KundePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fehler?: string; ok?: string; b?: string }> }) {
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
  const [plan, snapshots, mayEditPlan] = await Promise.all([buildAccountPlan(actor, id), listAccountPlanSnapshots(actor, id), canEditAccountPlan(actor, id)]);
  const research = await getCompanyResearch(actor, id);
  const mayCreate = canCreateSetup(actor, account);
  const mayDelete = canDeleteAccount(actor, account);
  const mayReassign = canReassignResponsibility(actor, account);
  const bdUsers = mayCreate || mayReassign
    ? [...new Map((await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users).innerJoin(schema.roleAssignments, eq(schema.roleAssignments.userId, schema.users.id)).where(eq(schema.roleAssignments.role, "BD"))).map((u) => [u.id, u])).values()]
    : [];

  // „Wo stehen wir?“ je Chance (Etappe 24): der Status gehört zur Chance, nicht zu Setup oder Kunde
  const ownerIds = [...new Set(opportunities.map((o) => o.ownerUserId))];
  const ownerNames = new Map(ownerIds.length ? (await db.query.users.findMany({ where: inArray(schema.users.id, ownerIds) })).map((u) => [u.id, u.displayName]) : []);
  const topCandidates = await topCandidatesForOpportunities(opportunities.map((o) => o.id)).catch(() => new Map());
  const ro = isReadOnlyFor(actor, id);
  const mayKeys = !ro && (hasRoleForAccountWrite(actor, account) || actor.roles.has("CEO"));
  const domainSuggestions = mayKeys ? await suggestedDomains(account.id, actor.workspaceId).catch(() => []) : [];
  const chanceRows = opportunities.map((o) => ({ id: o.id, title: o.title, status: o.status, kind: o.kind, ownerName: ownerNames.get(o.ownerUserId) ?? "?", setupName: o.setupName, version: ro ? undefined : o.version, candidate: topCandidates.get(o.id) ?? null }));
  const [runs, accountPlaybooks, salesOps, activeUsers] = await Promise.all([
    listRuns(actor, { accountId: id }),
    // Kunden- und Setup-Muster lassen sich vom Kunden aus starten (Setup-Muster in bestehendem oder neuem Setup);
    // Chancen-Muster laufen an einer Chance und werden dort gestartet.
    Promise.all([listPlaybooks(actor, { scope: "ACCOUNT", activeOnly: true }), listPlaybooks(actor, { scope: "SETUP", activeOnly: true })]).then(([a, b]) => [...a, ...b]),
    listSalesOpsUsers(actor.workspaceId),
    db.query.users.findMany({ where: eq(schema.users.status, "ACTIVE"), orderBy: (u, { asc }) => [asc(u.displayName)] }),
  ]);
  const mayStartPlaybook = mayReassign || mayCreate || isSalesOps(actor);
  const [health] = await computeHealthFor([{ id: account.id, name: account.name }]);
  const [initiatives, sosList] = await Promise.all([listInitiatives(actor, id), listSosForAccount(actor, id)]);
  const mayAgenda = canMaintainAgenda(actor, account);
  const sosSetups = setups.filter((x) => x.status !== "ARCHIVIERT").map((x) => ({ id: x.id, name: x.name }));
  const sosOrders = (health?.engagements ?? []).map((e) => ({ id: e.orderId, title: `${e.title} (${e.setupName})` }));
  const currentBdName = account.responsibleBdUserId
    ? (bdUsers.find((u) => u.id === account.responsibleBdUserId)?.displayName ?? (await db.query.users.findFirst({ where: eq(schema.users.id, account.responsibleBdUserId) }))?.displayName ?? "?")
    : null;

  // Kundenansicht in drei Buckets (Etappe 44): Grundlagen · Strategie · Operativ – nur der gewählte wird gezeigt
  const bucket: Bucket = sp.b === "strategie" || sp.b === "operativ" ? sp.b : "grundlagen";
  const back = `/kunden/${id}?b=${bucket}`;
  const keyInitiatives = initiatives.filter((i) => i.kind === "INITIATIVE" && i.status === "OFFEN");
  const cardsByIni = ro ? {} : await listCardsByInitiative(actor, account.id).catch(() => ({} as Record<string, never[]>));
  const cardCount = (iid: string) => (cardsByIni as Record<string, unknown[]>)[iid]?.length ?? 0;
  const iniCards = keyInitiatives.reduce((n, i) => n + cardCount(i.id), 0);
  const otherCards = (cardsByIni as Record<string, (typeof schema.suggestions.$inferSelect)[]>)["_ohne"] ?? [];
  const iniWork = keyInitiatives.length ? await db.query.workItems.findMany({ where: and(eq(schema.workItems.subjectType, "INITIATIVE"), inArray(schema.workItems.subjectId, keyInitiatives.map((i) => i.id))), columns: { subjectId: true, status: true } }) : [];
  const openWork = (iid: string) => iniWork.filter((w) => w.subjectId === iid && !["ERLEDIGT", "VERWORFEN", "ABGELEHNT"].includes(w.status)).length;
  const unassignedChances = opportunities.filter((o) => !o.initiativeId && !["BEENDET", "BEAUFTRAGT"].includes(o.status));
  const openSos = sosList.filter((x) => x.status !== "GELOEST");
  const tabs: { key: Bucket; label: string; hint: string }[] = [
    { key: "grundlagen", label: "1 Grundlagen", hint: `Health-Check, Kundenagenda, laufende Vorgehen` },
    { key: "strategie", label: "2 Strategie", hint: `${keyInitiatives.length} Schlüssel-Initiative(n)${iniCards + otherCards.length ? ` · ${iniCards + otherCards.length} KI-Vorschläge` : ""}` },
    { key: "operativ", label: "3 Operativ", hint: `${people.length} Personen${openSos.length ? ` · ${openSos.length} SOS offen` : ""} · Beschaffung, Setups` },
  ];

  return (
    <div className="space-y-6">
      <p className="text-sm"><Link href="/kunden">Kunden</Link> › {account.name}</p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{account.name}</h1>
        {health && <Link href={`/kunden/${account.id}?b=grundlagen`} className="no-underline" title="Health-Check"><HealthBadge score={health.score} level={health.level} coverage={health.coverage} /></Link>}
        {account.status === "ARCHIVED" && <Status label={accountStatusLabel.ARCHIVED!} />}
        <span className="muted text-sm">{orgTypeLabel[account.orgType] ?? account.orgType}{currentBdName ? ` · BD ${currentBdName}` : ""}</span>
        {mayDelete && <Link href={`/kunden/${account.id}/loeschen`} className="muted text-sm ml-auto">Kunde archivieren oder löschen</Link>}
      </div>
      {account.orgType === "SONSTIGE" && !ro && (hasRoleForAccountWrite(actor, account) || actor.roles.has("CEO")) && (
        <form action={setAccountOrgTypeAction} className="flex flex-wrap items-center gap-2 text-sm p-2" style={{ borderLeft: "4px solid #b7791f", background: "var(--surface-2)", borderRadius: 6 }}>
          <input type="hidden" name="accountId" value={account.id} />
          <span>Organisationstyp fehlt noch:</span>
          <select name="orgType" className="select" required defaultValue="" aria-label="Organisationstyp" style={{ width: "14rem" }}>
            <option value="" disabled>Bitte wählen …</option>
            {schema.orgTypeEnum.enumValues.filter((v) => v !== "SONSTIGE").map((v) => <option key={v} value={v}>{orgTypeLabel[v] ?? v}</option>)}
          </select>
          <button className="btn btn-small" type="submit">Speichern</button>
        </form>
      )}
      {account.status === "ARCHIVED" && <p className="text-sm" style={{ background: "#fdf6ec", border: "1px solid var(--border)", borderRadius: 8, padding: ".5rem .8rem" }}>Dieser Kunde ist archiviert. Alles bleibt erhalten; <Link href={`/kunden/${account.id}/loeschen`}>wiederherstellen oder endgültig löschen</Link>.</p>}
      {openSos.length > 0 && bucket !== "operativ" && (
        <p className="text-sm p-2" style={{ borderLeft: "4px solid #c0392b", background: "var(--surface-2)", borderRadius: 6 }}>
          <strong>SOS offen:</strong> {openSos.map((x) => x.title).join(" · ")} – <Link href={`/kunden/${account.id}?b=operativ#sos`}>zum SOS-Protokoll</Link>
        </p>
      )}
      <nav aria-label="Bereiche der Kundenansicht" className="flex flex-wrap gap-2 border-b" style={{ borderColor: "var(--border)" }}>
        {tabs.map((t) => (
          <Link key={t.key} href={`/kunden/${account.id}?b=${t.key}`} aria-current={bucket === t.key ? "page" : undefined} className="no-underline px-3 py-2 text-sm" style={{ borderBottom: bucket === t.key ? "3px solid var(--accent, #1f4e79)" : "3px solid transparent", color: "var(--text)", fontWeight: bucket === t.key ? 600 : 400 }}>
            {t.label}
            <span className="muted text-xs block" style={{ fontWeight: 400 }}>{t.hint}</span>
          </Link>
        ))}
      </nav>
      <Feedback params={sp} />

      {bucket === "grundlagen" && (
        <>
      {health && (
        <section className="card">
          <div className="flex flex-wrap items-baseline gap-3 mb-1">
            <h2 className="font-semibold">Health-Check – wie sicher sitzen wir im Sattel?</h2>
            <Link href={`/kunden/${account.id}/health`} className="btn btn-small ml-auto">{health.questions.length && !ro ? `Interview (${health.questions.length} offene Fragen)` : "Health-Check ansehen"}</Link>
          </div>
          <HealthBadge score={health.score} level={health.level} coverage={health.coverage} size="large" />
          <p className="text-sm mt-2">
            {health.engagements.length} Einsatz/Einsätze{health.engagements.filter((e) => e.plannedEnd).length ? ` · nächstes Ende ${fmtDate(health.engagements.find((e) => e.plannedEnd)!.plannedEnd)}` : ""}
            {health.questions.length > 0 && <span className="muted"> · fehlt: {health.questions.slice(0, 2).map((q) => q.key === "ENGAGEMENT_END" ? "Einsatzende" : q.key === "FEEDBACK" ? "Kundenfeedback" : q.key === "LISTING" ? "Listung" : q.key === "RISKS" ? "Risiken" : q.key === "PEOPLE" ? "Ansprechpartner" : "Einsätze").join(", ")}{health.questions.length > 2 ? " …" : ""}</span>}
          </p>
        </section>
      )}

          <KundenAgenda accountId={account.id} initiatives={initiatives} canEdit={mayAgenda && account.status !== "ARCHIVED"} back={back} cards={cardsByIni as Record<string, (typeof schema.suggestions.$inferSelect)[]>} kinds={["PRIORITAET", "HERAUSFORDERUNG"]} defaultKind="PRIORITAET" title="Kundenagenda – Prioritäten und Herausforderungen" intro={<>Was den Kunden treibt, in seinen Worten. Die <Link href={`/kunden/${account.id}?b=strategie`}>Schlüssel-Initiativen</Link> stehen unter Strategie – dort hängen Chancen, Vorgänge und KI-Vorschläge.</>} />
          {account.status === "DORMANT" && <p className="text-sm" style={{ background: "var(--warn-soft)", border: "1px solid var(--border)", borderRadius: 8, padding: ".5rem .8rem" }}>Dieser Kunde ruht. Mit dem Vorgehen „Altkunden-Reaktivierung“ wird er wieder aktiv angegangen.</p>}
          <PlaybookRuns
            startCollapsed
            runs={runs}
            back={back}
            users={activeUsers.map((u) => ({ id: u.id, displayName: u.displayName }))}
            start={mayStartPlaybook && account.status !== "ARCHIVED" ? { playbooks: accountPlaybooks, hidden: { accountId: account.id }, setups: setups.filter((x) => x.status !== "ARCHIVIERT").map((x) => ({ id: x.id, name: x.name })), defaultNewSetupName: `Reaktivierung ${new Date().getFullYear()}`, defaultOwnerId: account.responsibleBdUserId, salesOps, hint: "Muster für eine einzelne Chance (z. B. Ausschreibung) startest du auf der Chance selbst, unter „Vorgehen“." } : null}
          />
        </>
      )}

      {bucket === "strategie" && (
        <>
          <section className="card" id="initiativen">
            <h2 className="font-semibold mb-1">Schlüssel-Initiativen des Kunden ({keyInitiatives.length})</h2>
            <p className="muted text-sm mb-3">Je Initiative: die Chancen, die darauf einzahlen, die Vorgänge dazu und die KI-Vorschläge aus dem Eingang. Ein Klick öffnet die Initiative.</p>
            {keyInitiatives.length === 0 ? <p className="muted text-sm">Noch keine Schlüssel-Initiative erfasst. Tipp: aus einer Mail oder Account-Seite erkennt die KI sie als Karte.</p> : (
              <ul className="space-y-2">
                {keyInitiatives.map((i) => (
                  <li key={i.id}>
                    <Link href={`/kunden/${account.id}/initiativen/${i.id}`} className="no-underline block p-3" style={{ border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)" }}>
                      <span className="flex flex-wrap items-baseline gap-3">
                        <strong>{i.title}</strong>
                        {(i.dueDate || i.dueHint) && <span className="muted text-xs">Termin {i.dueDate ? fmtDate(i.dueDate) : `„${i.dueHint}“`}</span>}
                        <span className="text-xs ml-auto flex gap-3">
                          <span>{i.chances.filter((c) => c.status !== "BEENDET").length} Chance(n)</span>
                          <span>{openWork(i.id)} Vorgang/Vorgänge offen</span>
                          {cardCount(i.id) > 0 && <span style={{ color: "#b7791f", fontWeight: 600 }}>{cardCount(i.id)} KI-Vorschlag/Vorschläge</span>}
                          <span aria-hidden="true">›</span>
                        </span>
                      </span>
                      {i.description && <span className="muted text-xs block mt-1">{i.description.slice(0, 200)}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {mayAgenda && account.status !== "ARCHIVED" && (
              <details className="mt-3">
                <summary className="text-sm">Schlüssel-Initiative hinzufügen</summary>
                <form action={createInitiativeAction} className="grid sm:grid-cols-2 gap-3 mt-2">
                  <input type="hidden" name="accountId" value={account.id} />
                  <input type="hidden" name="back" value={back} />
                  <input type="hidden" name="kind" value="INITIATIVE" />
                  <div className="sm:col-span-2"><label className="label" htmlFor="iniTitle2">Bezeichnung</label><input id="iniTitle2" name="title" className="input" required minLength={3} placeholder="z. B. Jira-Ablösung bis Ende 2026" /></div>
                  <div className="sm:col-span-2"><label className="label" htmlFor="iniDesc2">Beschreibung (optional)</label><textarea id="iniDesc2" name="description" className="textarea" rows={2} /></div>
                  <div><label className="label" htmlFor="iniDue2">Datum (optional)</label><input id="iniDue2" name="dueDate" type="date" className="input" /></div>
                  <div><label className="label" htmlFor="iniHint2">oder ungefähr</label><input id="iniHint2" name="dueHint" className="input" placeholder="z. B. Q2 2027" /></div>
                  <div className="sm:col-span-2"><button className="btn btn-small" type="submit">Aufnehmen</button></div>
                </form>
              </details>
            )}
          </section>

          {unassignedChances.length > 0 && (
            <section className="card">
              <h2 className="font-semibold mb-1">Chancen ohne Initiative ({unassignedChances.length})</h2>
              <p className="muted text-sm mb-2">Auf welche Initiative zahlt die Chance ein? Zugeordnet erscheint sie in der Initiative.</p>
              <ul className="space-y-1 text-sm">
                {unassignedChances.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center gap-2">
                    <Link href={`/bedarfe/${o.id}`}>{o.title}</Link>
                    <span className="muted">· {opportunityStatusLabel[o.status] ?? o.status} · {o.setupName}</span>
                    {mayAgenda && keyInitiatives.length > 0 && (
                      <form action={linkChanceInitiativeAction} className="flex gap-1 items-center ml-auto">
                        <input type="hidden" name="opportunityId" value={o.id} />
                        <input type="hidden" name="back" value={back} />
                        <select name="initiativeId" className="select" required defaultValue="" aria-label="Initiative" style={{ width: "14rem" }}>
                          <option value="" disabled>Initiative wählen …</option>
                          {keyInitiatives.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
                        </select>
                        <button className="btn btn-secondary btn-small" type="submit">Zuordnen</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {otherCards.length > 0 && (
            <section className="card">
              <h2 className="font-semibold mb-1">Weitere KI-Vorschläge zu diesem Kunden ({otherCards.length})</h2>
              <p className="muted text-sm mb-2">Aus dem Eingang, ohne erkennbaren Bezug zu einer Initiative.</p>
              <ul className="space-y-2">{otherCards.slice(0, 5).map((c) => <EingangCard key={c.id} s={c} canDecide back={back} />)}</ul>
              {otherCards.length > 5 && (
                <details className="mt-2"><summary className="text-sm muted">+ {otherCards.length - 5} weitere</summary><ul className="space-y-2 mt-2">{otherCards.slice(5).map((c) => <EingangCard key={c.id} s={c} canDecide back={back} />)}</ul></details>
              )}
            </section>
          )}

          <details className="card">
            <summary className="font-semibold">Alle Chancen im Überblick ({opportunities.length})<Term k="CHANCE" /></summary>
            <div className="mt-2">
              <ChancenUebersicht chances={chanceRows} showSetup={setups.length > 1} emptyText="Noch keine Chance benannt. Chancen entstehen im Setup („Chance erfassen“), in einer Initiative oder über den Assistenten." back={back} />
            </div>
          </details>
      <details className="card">
        <summary className="font-semibold">Accountplan – Ausbau-Vorhaben und gespeicherte Stände</summary>
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
      </details>
        </>
      )}

      {bucket === "operativ" && (
        <>
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

          <div id="sos">{(!ro && account.status !== "ARCHIVED") || openSos.length ? <SosPanel accountId={account.id} sos={sosList} back={back} canEdit={mayAgenda} setups={sosSetups} orders={sosOrders} /> : null}</div>
          <Beschaffung account={account} canEdit={mayAgenda && account.status !== "ARCHIVED"} back={back} />
          {getConfig().FEATURE_BESETZUNG === "true" && <Beschaffungsprofil actor={actor} account={account} back={back} />}
          <WorkBlock actor={actor} subjectType="KUNDE" subjectId={account.id} back={back} title="Vorgänge am Kunden (ohne Initiative)" canCreate={account.status !== "ARCHIVED"} />
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

      <section className="card">
        <h2 className="font-semibold mb-2">Projektsetups ({setups.length})</h2>
        {setups.length === 0 ? (
          <p className="muted text-sm">Noch kein Setup. Ein Setup braucht nur Kunde, Namen und einen Kontextsatz – oder bleibt bewusst Entwurf.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Setup</th><th>Status</th><th>Chancen</th><th>Sichtbarkeit</th><th>BD</th><th>Geändert</th></tr></thead>
            <tbody>
              {setups.map((s) => (
                <tr key={s.id}>
                  <td><Link href={`/setups/${s.id}`}>{s.name}</Link>{s.contextNote && <div className="muted text-sm">{s.contextNote}</div>}</td>
                  <td><Status label={setupStatusLabel[s.status] ?? s.status} /></td>
                  <td className="text-sm">{(() => {
                    const mine = chanceRows.filter((c) => opportunities.find((o) => o.id === c.id)?.setupId === s.id && c.status !== "BEENDET");
                    if (mine.length === 0) return <span className="muted">keine</span>;
                    const byStatus = new Map<string, number>();
                    for (const c of mine) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
                    return `${mine.length}: ${[...byStatus].map(([st, n]) => `${n}× ${opportunityStatusLabel[st] ?? st}`).join(", ")}`;
                  })()}</td>
                  <td>{visibilityLabel[s.visibility]}</td>
                  <td>{s.bdUserId ? "zugeordnet" : <Status label="Zuordnung offen" />}</td>
                  <td>{fmtDate(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {mayCreate && (
        <details className="card" open={setups.length === 0}>
          <summary>Setup anlegen<Term k="SETUP" /></summary>
          <form action={createSetupAction} className="mt-3 grid sm:grid-cols-2 gap-3">
            <input type="hidden" name="accountId" value={account.id} />
            <div className="sm:col-span-2"><label className="label" htmlFor="name">Verständlicher Setup-Name</label><input id="name" name="name" className="input" required minLength={3} placeholder="z. B. Plattformteam" /></div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="contextNote">Kontextsatz (optional – leer lassen für bewussten Entwurf)</label>
              <textarea id="contextNote" name="contextNote" className="textarea" placeholder="Was läuft hier? Ein Satz genügt." />
            </div>
            <div>
              <label className="label" htmlFor="bdUserId">Zuständiger BD</label>
              <select id="bdUserId" name="bdUserId" className="select" defaultValue={account.responsibleBdUserId && bdUsers.some((u) => u.id === account.responsibleBdUserId) ? account.responsibleBdUserId : ""}>
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
              <select id="creatorContribution" name="creatorContribution" className="select" defaultValue={account.responsibleBdUserId === actor.userId ? "BD_ZUSTAENDIG" : "ANKER_KONTEXT"}>
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
          <section className="card text-sm">
            <details id="kennungen" open={mayKeys && account.mailDomains.length === 0 && domainSuggestions.length > 0}>
        <summary style={{ cursor: "pointer" }}>
          Kennungen für den Eingang:{" "}
          {account.mailDomains.length + account.aliases.length > 0 ? <strong>{[...account.mailDomains, ...account.aliases.map((a) => `„${a}“`)].join(", ")}</strong> : <span style={{ color: "#b7791f" }}>noch keine – Mails werden nur über Namen erkannt</span>}
        </summary>
        <p className="muted text-xs mt-1">Trifft eine Kennung, ordnet der Eingang Mails und Notizen eindeutig diesem Kunden zu – die KI kann das nicht überstimmen. Mail-Domäne: alles nach dem @ (Subdomänen inklusive). Kürzel: Namen, unter denen der Kunde in Mails auftaucht (z. B. „TFS“).</p>
        {mayKeys ? (
          <form action={setAccountKeysAction} className="flex flex-wrap gap-2 items-end mt-2">
            <input type="hidden" name="accountId" value={account.id} />
            <div><label className="label" htmlFor="kDomains">Mail-Domänen</label><input id="kDomains" name="domains" className="input" style={{ width: "20rem" }} defaultValue={(account.mailDomains.length ? account.mailDomains : domainSuggestions).join(", ")} placeholder="kunde.de, kunde-gruppe.com" /></div>
            <div><label className="label" htmlFor="kAliases">Kürzel</label><input id="kAliases" name="aliases" className="input" style={{ width: "16rem" }} defaultValue={account.aliases.join(", ")} placeholder="z. B. TFS, Toyota Bank" /></div>
            <button className="btn btn-small" type="submit">Speichern</button>
            {account.mailDomains.length === 0 && domainSuggestions.length > 0 && <span className="muted text-xs">Vorbelegt aus den E-Mail-Adressen bekannter Personen – bitte prüfen.</span>}
          </form>
        ) : null}
      </details>
          </section>
      {/* Öffentliche Unternehmensrecherche (Etappe 16): eng begrenzte Ausnahme – nur öffentliche Firmendaten, nie Personennamen */}
      <section className="card">
        <div className="flex flex-wrap items-baseline gap-3 mb-2">
          <h2 className="font-semibold">Öffentliche Informationen zum Unternehmen</h2>
          {!ro && <form action={refreshCompanyResearchAction} className="ml-auto">
            <input type="hidden" name="accountId" value={account.id} />
            <button className="btn btn-secondary btn-small" type="submit">{research.latest ? "Aktualisieren" : "Recherche starten"}</button>
          </form>}
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

          <Comments actor={actor} subjectType="KUNDE" subjectId={account.id} back={back} />
        </>
      )}
    </div>
  );
}
