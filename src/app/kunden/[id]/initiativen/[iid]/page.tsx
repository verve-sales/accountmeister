import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { getAccount } from "@/modules/accounts/service";
import { isReadOnlyFor } from "@/modules/identity/actor";
import { canEditSetup, loadSetupContext } from "@/modules/identity/authz";
import { canMaintainAgenda, initiativeKindLabel, type InitiativeKind } from "@/modules/agenda/service";
import { listOpportunitiesForAccount } from "@/modules/opportunities/service";
import { listSetupsForAccount } from "@/modules/setups/service";
import { listCardsByInitiative } from "@/modules/suggestions/service";
import { topCandidatesForOpportunities } from "@/modules/staffing/service";
import { ChancenUebersicht } from "@/components/ChancenUebersicht";
import { EingangCard } from "@/components/EingangCard";
import { WorkBlock } from "@/components/Work";
import { Feedback } from "@/components/Feedback";
import { Term } from "@/components/Term";
import { fmtDate } from "@/lib/labels";
import { workStatusLabel } from "@/modules/work/service";
import { createOpportunityAction, linkChanceInitiativeAction, setInitiativeStatusAction } from "@/app/actions";
import { chanceKindValues, chanceKindLabel } from "@/modules/ai/schemas";

/**
 * Schlüssel-Initiative (Etappe 44, Kundenansicht Bucket 2): von der Kundenübersicht eine Ebene tiefer – hier stehen
 * die Chancen, die auf die Initiative einzahlen, die Vorgänge dazu und die KI-Vorschläge aus dem Eingang.
 */
export default async function InitiativePage({ params, searchParams }: { params: Promise<{ id: string; iid: string }>; searchParams: Promise<{ fehler?: string; ok?: string }> }) {
  const { id, iid } = await params;
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
  const ini = await db.query.accountInitiatives.findFirst({ where: and(eq(schema.accountInitiatives.id, iid), eq(schema.accountInitiatives.accountId, account.id)) });
  if (!ini) notFound();
  const back = `/kunden/${id}/initiativen/${iid}`;
  const ro = isReadOnlyFor(actor, id);
  const mayAgenda = !ro && canMaintainAgenda(actor, account);
  const [opps, setups, cardsByIni] = await Promise.all([listOpportunitiesForAccount(actor, id), listSetupsForAccount(actor, id), ro ? Promise.resolve({}) : listCardsByInitiative(actor, id).catch(() => ({}))]);
  const cards = (cardsByIni as Record<string, (typeof schema.suggestions.$inferSelect)[]>)[iid] ?? [];
  const mine = opps.filter((o) => o.initiativeId === iid);
  const free = opps.filter((o) => !o.initiativeId && !["BEENDET", "BEAUFTRAGT"].includes(o.status));
  const owners = mine.length ? await db.query.users.findMany({ where: inArray(schema.users.id, [...new Set(mine.map((o) => o.ownerUserId))]), columns: { id: true, displayName: true } }) : [];
  const top = await topCandidatesForOpportunities(mine.map((o) => o.id)).catch(() => new Map());
  const rows = mine.map((o) => ({ id: o.id, title: o.title, status: o.status, kind: o.kind, ownerName: owners.find((u) => u.id === o.ownerUserId)?.displayName ?? "?", setupName: o.setupName, version: ro ? undefined : o.version, candidate: top.get(o.id) ?? null }));
  // Vorgänge an den Chancen dieser Initiative (die Vorgänge der Initiative selbst stehen im Block darunter)
  const chanceWork = mine.length ? await db.query.workItems.findMany({ where: and(eq(schema.workItems.subjectType, "CHANCE"), inArray(schema.workItems.subjectId, mine.map((o) => o.id))), columns: { id: true, title: true, status: true, dueDate: true, subjectId: true } }) : [];
  const openChanceWork = chanceWork.filter((w) => !["ERLEDIGT", "VERWORFEN", "ABGELEHNT"].includes(w.status));
  const editableSetups: { id: string; name: string }[] = [];
  for (const st of setups.filter((x) => x.status !== "ARCHIVIERT")) {
    const c = await loadSetupContext(actor, st.id);
    if (c && canEditSetup(actor, c)) editableSetups.push({ id: st.id, name: st.name });
  }

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/kunden">Kunden</Link> › <Link href={`/kunden/${id}`}>{account.name}</Link> › <Link href={`/kunden/${id}?b=strategie`}>Strategie</Link> › {ini.title}
      </p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{ini.title}</h1>
        <span className="muted text-sm">{initiativeKindLabel[ini.kind as InitiativeKind] ?? ini.kind}{ini.dueDate || ini.dueHint ? ` · Termin ${ini.dueDate ? fmtDate(ini.dueDate) : `„${ini.dueHint}“`}` : ""}{ini.status !== "OFFEN" ? ` · ${ini.status === "ERLEDIGT" ? "erledigt" : "verworfen"}` : ""}</span>
        {mayAgenda && ini.status === "OFFEN" && (
          <form action={setInitiativeStatusAction} className="flex gap-1 ml-auto">
            <input type="hidden" name="initiativeId" value={ini.id} />
            <input type="hidden" name="version" value={ini.version} />
            <input type="hidden" name="back" value={`/kunden/${id}?b=strategie`} />
            <button className="btn btn-secondary btn-small" name="status" value="ERLEDIGT" type="submit">Erledigt</button>
            <button className="btn btn-secondary btn-small" name="status" value="VERWORFEN" type="submit">Verwerfen</button>
          </form>
        )}
      </div>
      {ini.description && <p className="text-sm" style={{ whiteSpace: "pre-wrap" }}>{ini.description}</p>}
      <Feedback params={sp} />

      {cards.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2" style={{ color: "#b7791f" }}>KI-Vorschläge zu dieser Initiative ({cards.length})</h2>
          <ul className="space-y-2">{cards.map((c) => <EingangCard key={c.id} s={c} canDecide back={back} routeLine={false} />)}</ul>
        </section>
      )}

      <section className="card">
        <h2 className="font-semibold mb-2">Chancen, die auf die Initiative einzahlen ({mine.length})<Term k="CHANCE" /></h2>
        <ChancenUebersicht chances={rows} showSetup={setups.length > 1} emptyText="Noch keine Chance zu dieser Initiative." back={back} />
        {!ro && (
          <div className="grid lg:grid-cols-2 gap-6 mt-3">
            {mayAgenda && free.length > 0 && (
              <form action={linkChanceInitiativeAction} className="flex flex-wrap gap-2 items-end text-sm">
                <input type="hidden" name="initiativeId" value={ini.id} />
                <input type="hidden" name="back" value={back} />
                <div className="grow"><label className="label" htmlFor="linkOpp">Bestehende Chance zuordnen</label>
                  <select id="linkOpp" name="opportunityId" className="select" required defaultValue="">
                    <option value="" disabled>Chance ohne Initiative wählen …</option>
                    {free.map((o) => <option key={o.id} value={o.id}>{o.title} ({o.setupName})</option>)}
                  </select>
                </div>
                <button className="btn btn-secondary btn-small" type="submit">Zuordnen</button>
              </form>
            )}
            {editableSetups.length > 0 && (
              <details>
                <summary className="text-sm">Neue Chance zu dieser Initiative</summary>
                <form action={createOpportunityAction} className="grid sm:grid-cols-2 gap-2 mt-2 text-sm">
                  <input type="hidden" name="initiativeId" value={ini.id} />
                  <input type="hidden" name="back" value={back} />
                  <div className="sm:col-span-2"><label className="label" htmlFor="oTitle">Titel</label><input id="oTitle" name="title" className="input" required minLength={3} maxLength={200} /></div>
                  <div className="sm:col-span-2"><label className="label" htmlFor="oNeed">Bedarf in Kundensprache</label><textarea id="oNeed" name="needDescription" className="textarea" rows={2} required minLength={10} /></div>
                  <div><label className="label" htmlFor="oSetup">Setup</label><select id="oSetup" name="setupId" className="select" required defaultValue={editableSetups.length === 1 ? editableSetups[0]!.id : ""}><option value="" disabled>Bitte wählen …</option>{editableSetups.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
                  <div><label className="label" htmlFor="oKind">Art</label><select id="oKind" name="kind" className="select" defaultValue="VERVE_EXPERTE">{chanceKindValues.map((k) => <option key={k} value={k}>{chanceKindLabel[k]}</option>)}</select></div>
                  <div className="sm:col-span-2"><button className="btn btn-small" type="submit">Chance anlegen</button></div>
                </form>
              </details>
            )}
          </div>
        )}
      </section>

      {openChanceWork.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Offene Vorgänge an diesen Chancen ({openChanceWork.length})</h2>
          <ul className="space-y-1 text-sm">
            {openChanceWork.map((w) => (
              <li key={w.id}><Link href={`/vorgaenge/${w.id}`}>{w.title}</Link> <span className="muted">· {workStatusLabel[w.status] ?? w.status}{w.dueDate ? ` · fällig ${fmtDate(w.dueDate)}` : ""} · {mine.find((o) => o.id === w.subjectId)?.title}</span></li>
            ))}
          </ul>
        </section>
      )}

      <WorkBlock actor={actor} subjectType="INITIATIVE" subjectId={ini.id} back={back} title="Vorgänge zur Initiative" canCreate={!ro && ini.status === "OFFEN"} />
    </div>
  );
}
