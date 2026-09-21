import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { getOpportunityDetail, MEDDPICC_KEYS } from "@/modules/opportunities/service";
import { getOpportunityAdvice, proposeOpportunityAdvice, ruleBasedOpportunityAdvice, type OpportunityAdviceRow } from "@/modules/opportunities/advisor";
import { getBuyingCenterAdvice, proposeBuyingCenterAdvice, ruleBasedBuyingCenterAdvice, type BuyingCenterAdviceRow } from "@/modules/opportunities/buyingCenterAdvisor";
import type { StrategyMove } from "@/modules/strategy/service";
import type { BuyingCenterProposal, StrategyProposal } from "@/modules/ai/schemas";
import { decisionRoleValues } from "@/modules/ai/schemas";
import { Feedback } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { SuggestButton } from "@/components/SuggestButton";
import { chanceKindLabel, chanceKindValues } from "@/modules/ai/schemas";
import { groupByFamily } from "@/modules/roles/catalog";
import { decisionRoleLabel, engagementStatusLabel, epistemicLabel, fmtDate, fmtDateTime, offerStatusLabel, opportunityStatusLabel, orderStatusLabel, requirementStatusLabel, sourceTypeLabel } from "@/lib/labels";
import {
  addParticipationAction, addStartRequirementAction, cancelOrderAction, changeOfferStatusAction, changeOpportunityStatusAction, confirmOpportunityAction, confirmOrderAction, createOfferAction,
  createOrderAction, markReadyAction, markStartedAction, orderEvidenceIncompleteAction, presentOfferAction, removeParticipationAction, saveBuyingCenterAdviceAction, saveMeddpiccAction, saveOpportunityAdviceAction, setRequirementStatusAction, updateOpportunityAction,
} from "../../actions";

const VERLAUF = ["IN_KLAERUNG", "BESTAETIGT", "PROFIL_ANGEBOT_VORGESTELLT", "AUSWAHL_BESTELLUNG", "BEAUFTRAGT"] as const;

function EvidenceFields({ prefix, sources, label = "Beleg" }: { prefix: string; sources: { id: string; title: string; type: string }[]; label?: string }) {
  return (
    <>
      <div>
        <label className="label" htmlFor={`${prefix}Source`}>{label}: vorhandene Quelle</label>
        <select id={`${prefix}Source`} name="sourceId" className="select" defaultValue="">
          <option value="">– keine, Belegnotiz unten –</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{sourceTypeLabel[s.type] ?? s.type}: {s.title}</option>)}
        </select>
      </div>
      <div><label className="label" htmlFor={`${prefix}Text`}>oder Belegnotiz (wer, was, wann)</label><input id={`${prefix}Text`} name="evidenceText" className="input" placeholder="mind. 10 Zeichen" /></div>
    </>
  );
}

export default async function BedarfPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fehler?: string; ok?: string; berater?: string; bcberater?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let d;
  try {
    d = await getOpportunityDetail(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const { opp, ctx, canEdit } = d;
  const name = (uid: string | null | undefined) => (uid ? d.userNames.get(uid) ?? "?" : "–");

  // Persönlicher KI-Berater für diese Chance (Etappe 15): Vorbelegung mit KI-Vorschlag (auf Wunsch),
  // sonst letzte Fassung, sonst regelbasiert – gespeichert wird erst mit „Fassung speichern“.
  const advice = await getOpportunityAdvice(actor, id);
  let adviceDraft: StrategyProposal;
  let adviceDraftNote = "";
  let adviceAiJobId: string | null = null;
  let adviceProposalError: string | null = null;
  if (sp.berater && advice.canEdit) {
    try {
      const p = await proposeOpportunityAdvice(actor, id);
      adviceDraft = p.proposal;
      adviceDraftNote = p.note || "KI-Vorschlag – jede Zeile prüfen, ändern oder entfernen; gespeichert wird erst mit „Fassung speichern“.";
      adviceAiJobId = p.aiJobId;
    } catch (e) {
      adviceProposalError = e instanceof DomainError ? e.message : "Der KI-Vorschlag ist gerade nicht möglich.";
      adviceDraft = advice.latest ? adviceFromRow(advice.latest) : ruleBasedOpportunityAdvice(advice.analysis);
    }
  } else if (advice.latest) {
    adviceDraft = adviceFromRow(advice.latest);
    adviceDraftNote = `Vorbelegt mit Fassung ${advice.latest.versionNo} vom ${fmtDate(advice.latest.createdAt)}.`;
  } else {
    adviceDraft = ruleBasedOpportunityAdvice(advice.analysis);
    adviceDraftNote = "Noch keine Fassung – regelbasierter Entwurf aus der Lageanalyse dieser Chance.";
  }
  const adviceMoves = [...adviceDraft.moves, ...Array.from({ length: Math.max(0, 5 - adviceDraft.moves.length) }, () => ({ title: "", why: "", ownerRole: "BD" as const, evidenceQuote: "" }))].slice(0, 8);
  const adviceRisks = [...adviceDraft.risks, ...Array.from({ length: Math.max(0, 3 - adviceDraft.risks.length) }, () => ({ text: "", evidenceQuote: "" }))].slice(0, 6);
  const adviceQuestions = [...adviceDraft.openQuestions, ...Array.from({ length: Math.max(0, 3 - adviceDraft.openQuestions.length) }, () => "")].slice(0, 6);

  // Buying-Center-Berater (Etappe 17): geht die sechs Entscheidungsrollen dieser Chance durch, gibt Hinweise zu Lücken.
  const bc = await getBuyingCenterAdvice(actor, id);
  let bcDraft: BuyingCenterProposal;
  let bcDraftNote = "";
  let bcAiJobId: string | null = null;
  let bcProposalError: string | null = null;
  if (sp.bcberater && bc.canEdit) {
    try {
      const p = await proposeBuyingCenterAdvice(actor, id);
      bcDraft = p.proposal;
      bcDraftNote = p.note || "KI-Vorschlag – jede Zeile prüfen, ändern oder entfernen; gespeichert wird erst mit „Fassung speichern“.";
      bcAiJobId = p.aiJobId;
    } catch (e) {
      bcProposalError = e instanceof DomainError ? e.message : "Der KI-Vorschlag ist gerade nicht möglich.";
      bcDraft = bc.latest ? bcAdviceFromRow(bc.latest) : ruleBasedBuyingCenterAdvice(bc.analysis, bc.roleStatus);
    }
  } else if (bc.latest) {
    bcDraft = bcAdviceFromRow(bc.latest);
    bcDraftNote = `Vorbelegt mit Fassung ${bc.latest.versionNo} vom ${fmtDate(bc.latest.createdAt)}.`;
  } else {
    bcDraft = ruleBasedBuyingCenterAdvice(bc.analysis, bc.roleStatus);
    bcDraftNote = "Noch keine Fassung – regelbasierter Entwurf aus dem dokumentierten Buyingcenter-Stand.";
  }
  const bcHintByRole = new Map(bcDraft.roles.map((r) => [r.role, r]));
  const bcQuestions = [...bcDraft.openQuestions, ...Array.from({ length: Math.max(0, 3 - bcDraft.openQuestions.length) }, () => "")].slice(0, 6);
  const closed = opp.status === "BEENDET";
  const verlaufIdx = VERLAUF.indexOf(opp.status as (typeof VERLAUF)[number]);
  const md = opp.meddpicc ?? {};

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/kunden">Kunden</Link> › <Link href={`/kunden/${ctx.account.id}`}>{ctx.account.name}</Link> › <Link href={`/setups/${ctx.setup.id}`}>{ctx.setup.name}</Link> › Chance
      </p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{opp.title}</h1>
        <Status label={opportunityStatusLabel[opp.status] ?? opp.status} />
        {opp.fastTrack && <Status label="Direkte Anfrage (Fast-Track)" />}
        <span className="muted text-sm">Verantwortlich: {name(opp.ownerUserId)} · angelegt {fmtDateTime(opp.createdAt)}{opp.requestedAt && <> · Anfrage eingegangen {fmtDateTime(opp.requestedAt)}</>}</span>
        {!canEdit && <span className="muted text-sm">(nur lesend)</span>}
      </div>
      <Feedback params={sp} />

      {/* Kompakter Gesamtverlauf (9.1) – Zustände bleiben je Objekt getrennt */}
      <section className="card">
        <ol className="flex flex-wrap gap-2 text-sm">
          {VERLAUF.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span className={i <= verlaufIdx ? "font-semibold" : "muted"}>{opportunityStatusLabel[s]}</span>
              {i < VERLAUF.length - 1 && <span className="muted">→</span>}
            </li>
          ))}
          {(opp.status === "ZURUECKGESTELLT" || opp.status === "BEENDET") && <li className="muted">· {opportunityStatusLabel[opp.status]}{opp.statusReason && `: ${opp.statusReason}`}</li>}
        </ol>
        <p className="muted text-xs mt-1">Orientierung, keine Pflichtschleuse: Zugangsentwicklung läuft parallel weiter; Angebot, Auftrag und Einsatz haben eigene Zustände.</p>
      </section>

      {/* Wofür-Verknüpfungen (E-045): was schon auf diese Chance einzahlt */}
      {(d.linked.signals.length + d.linked.actions.length + d.linked.questions.length + d.linked.suggestions.length > 0) && (
        <section className="card">
          <h2 className="font-semibold mb-2">Was auf diese Chance einzahlt</h2>
          <div className="grid sm:grid-cols-2 gap-4 text-sm">
            {d.linked.actions.length > 0 && <div><div className="font-medium mb-1">Aktionen ({d.linked.actions.length})</div><ul className="space-y-1">{d.linked.actions.map((a) => <li key={a.id}>{a.title} <Status label={a.status} /></li>)}</ul></div>}
            {d.linked.signals.length > 0 && <div><div className="font-medium mb-1">Beobachtungen ({d.linked.signals.length})</div><ul className="space-y-1">{d.linked.signals.map((x) => <li key={x.id}>{x.observation.slice(0, 160)}</li>)}</ul></div>}
            {d.linked.questions.length > 0 && <div><div className="font-medium mb-1">Offene Fragen ({d.linked.questions.length})</div><ul className="space-y-1">{d.linked.questions.map((x) => <li key={x.id}>{x.question}</li>)}</ul></div>}
            {d.linked.suggestions.length > 0 && <div><div className="font-medium mb-1">Offene Vorschläge ({d.linked.suggestions.length})</div><ul className="space-y-1">{d.linked.suggestions.map((x) => <li key={x.id}>{x.title}</li>)}</ul></div>}
          </div>
        </section>
      )}

      {/* Chance */}
      <section className="card">
        <h2 className="font-semibold mb-2">Chance</h2>
        <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div className="sm:col-span-2"><dt className="muted">Wofür</dt><dd><strong>{chanceKindLabel[opp.kind]}</strong>{opp.roleId ? ` · ${d.roles.find((r) => r.id === opp.roleId)?.name ?? "Rolle"}` : " · Standardrolle noch offen"}{opp.headcount ? ` · ${opp.headcount}×` : ""}{opp.horizon ? ` · ${opp.horizon}` : ""}{opp.status === "ANTIZIPIERT" && <span className="muted"> · antizipiert – vom Kunden noch nicht ausgesprochen</span>}</dd></div>
          <div className="sm:col-span-2"><dt className="muted">Beschreibung in Kundensprache</dt><dd className="whitespace-pre-wrap">{opp.needDescription}</dd></div>
          <div><dt className="muted">Konkreter Anlass</dt><dd>{opp.trigger ?? "–"}</dd></div>
          <div><dt className="muted">Herkunft</dt><dd>{d.signal ? <>Beobachtung: „{d.signal.observation}“</> : "direkt erfasst"}</dd></div>
          <div className="sm:col-span-2">
            <dt className="muted">Bestätigung</dt>
            <dd>
              {opp.confirmedAt ? (
                <>Bestätigt am {fmtDateTime(opp.confirmedAt)}{opp.confirmedSourceId && <> · <Link href={`/quellen/${opp.confirmedSourceId}`}>Quelle ansehen</Link></>}{opp.confirmedNote && <> · {opp.confirmedNote}</>}</>
              ) : <span className="muted">noch nicht bestätigt – eine Bestätigung braucht Quelle und Zeitpunkt</span>}
            </dd>
          </div>
        </dl>
        {canEdit && !closed && (
          <div className="mt-3 space-y-3">
            {opp.status === "ANTIZIPIERT" && (
              <form action={changeOpportunityStatusAction} className="flex flex-wrap gap-2 items-center text-sm">
                <input type="hidden" name="opportunityId" value={opp.id} />
                <input type="hidden" name="version" value={opp.version} />
                <input type="hidden" name="reason" value="Vom Kunden angesprochen" />
                <span className="muted">Der Kunde hat den Bedarf jetzt angesprochen?</span>
                <button className="btn btn-secondary btn-small" name="status" value="IN_KLAERUNG">In Klärung nehmen</button>
              </form>
            )}
            {(opp.status === "ANTIZIPIERT" || opp.status === "IN_KLAERUNG" || opp.status === "ZURUECKGESTELLT") && (
              <details>
                <summary>Chance bestätigen (mit Beleg)</summary>
                <form action={confirmOpportunityAction} className="mt-2 grid sm:grid-cols-2 gap-3">
                  <input type="hidden" name="opportunityId" value={opp.id} />
                  <input type="hidden" name="version" value={opp.version} />
                  <EvidenceFields prefix="conf" sources={d.sources} label="Bestätigung durch den Kunden" />
                  <div className="sm:col-span-2"><label className="label" htmlFor="confNote">Anmerkung (optional; Budget-/Beschaffungsinfo darf noch fehlen)</label><input id="confNote" name="confirmedNote" className="input" /></div>
                  <div className="sm:col-span-2"><button className="btn" type="submit">Chance bestätigen</button></div>
                </form>
              </details>
            )}
            <details>
              <summary>Chance bearbeiten</summary>
              <form action={updateOpportunityAction} className="mt-2 grid sm:grid-cols-2 gap-3">
                <input type="hidden" name="opportunityId" value={opp.id} />
                <input type="hidden" name="version" value={opp.version} />
                <div><label className="label" htmlFor="oTitle">Titel</label><input id="oTitle" name="title" className="input" required minLength={3} defaultValue={opp.title} /></div>
                <div>
                  <label className="label" htmlFor="oOwner">Verantwortlich</label>
                  <select id="oOwner" name="ownerUserId" className="select" defaultValue={opp.ownerUserId}>{d.users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
                </div>
                <div className="sm:col-span-2"><label className="label" htmlFor="oNeed">Beschreibung in Kundensprache</label><textarea id="oNeed" name="needDescription" className="textarea" required minLength={10} defaultValue={opp.needDescription} /></div>
                <div className="sm:col-span-2"><label className="label" htmlFor="oTrigger">Konkreter Anlass</label><input id="oTrigger" name="trigger" className="input" defaultValue={opp.trigger ?? ""} /></div>
                <div>
                  <label className="label" htmlFor="oKind">Wofür – Art der Chance</label>
                  <select id="oKind" name="kind" className="select" defaultValue={opp.kind}>{chanceKindValues.map((k) => <option key={k} value={k}>{chanceKindLabel[k]}</option>)}</select>
                </div>
                <div>
                  <label className="label" htmlFor="oRole">Standardrolle</label>
                  <select id="oRole" name="roleId" className="select" defaultValue={opp.roleId ?? ""}>
                    <option value="">– noch offen –</option>
                    {groupByFamily(d.roles).map((g) => <optgroup key={g.family} label={g.label}>{g.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</optgroup>)}
                  </select>
                </div>
                <div><label className="label" htmlFor="oHeadcount">Anzahl</label><input id="oHeadcount" name="headcount" type="number" min={1} max={999} step={1} className="input" defaultValue={opp.headcount ?? ""} /></div>
                <div><label className="label" htmlFor="oHorizon">Zeithorizont</label><input id="oHorizon" name="horizon" className="input" defaultValue={opp.horizon ?? ""} placeholder="z. B. Q1 2027" maxLength={60} /></div>
                <div className="sm:col-span-2"><button className="btn" type="submit">Speichern</button></div>
              </form>
            </details>
            <details>
              <summary>Zurückstellen / Beenden (mit Begründung)</summary>
              <form action={changeOpportunityStatusAction} className="mt-2 flex flex-wrap gap-2 items-end">
                <input type="hidden" name="opportunityId" value={opp.id} />
                <input type="hidden" name="version" value={opp.version} />
                <div><label className="label" htmlFor="oReason">Begründung</label><input id="oReason" name="reason" className="input" style={{ width: "24rem" }} required minLength={3} /></div>
                {opp.status !== "ZURUECKGESTELLT" && opp.status !== "BEAUFTRAGT" && <button className="btn btn-secondary" name="status" value="ZURUECKGESTELLT">Zurückstellen</button>}
                {opp.status === "ZURUECKGESTELLT" && <button className="btn btn-secondary" name="status" value="IN_KLAERUNG">Wieder in Klärung</button>}
                <button className="btn btn-secondary" name="status" value="BEENDET">Beenden</button>
              </form>
            </details>
          </div>
        )}
      </section>

      {/* Buyingcenter (8.3) */}
      <section className="card">
        <h2 className="font-semibold mb-2">Buyingcenter für diese Chance ({d.participations.length})</h2>
        <p className="muted text-sm mb-2">Unbekannte Funktionen ohne erfundene Person anlegen. Eine Person kann mehrere Rollen haben. Ein Titel belegt keine Entscheidungsvollmacht.</p>
        {d.participations.length === 0 ? <p className="muted text-sm">Noch keine Rollen erfasst.</p> : (
          <table className="list">
            <thead><tr><th>Rolle</th><th>Person</th><th>Erkenntnisstatus</th><th>Anmerkung</th>{canEdit && <th></th>}</tr></thead>
            <tbody>
              {d.participations.map((p) => (
                <tr key={p.id}>
                  <td>{decisionRoleLabel[p.role] ?? p.role}</td>
                  <td>{p.personName ?? <span className="muted">Funktion bekannt, Person offen</span>}</td>
                  <td className="text-sm">{epistemicLabel[p.epistemicStatus] ?? p.epistemicStatus}{p.evidenceSourceId && <> · <Link href={`/quellen/${p.evidenceSourceId}`}>Quelle</Link></>}</td>
                  <td className="text-sm">{p.note ?? "–"}</td>
                  {canEdit && (
                    <td>
                      <form action={removeParticipationAction}><input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="participationId" value={p.id} /><button className="btn btn-secondary btn-small" type="submit">Entfernen</button></form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canEdit && !closed && (
          <details className="mt-3">
            <summary>Rolle hinzufügen</summary>
            <form action={addParticipationAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="opportunityId" value={opp.id} />
              <div>
                <label className="label" htmlFor="pRole">Rolle</label>
                <select id="pRole" name="role" className="select">{Object.entries(decisionRoleLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </div>
              <div>
                <label className="label" htmlFor="pPerson">Person (optional)</label>
                <select id="pPerson" name="personId" className="select" defaultValue=""><option value="">– Funktion bekannt, Person offen –</option>{d.persons.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select>
              </div>
              <div>
                <label className="label" htmlFor="pEpi">Erkenntnisstatus</label>
                <select id="pEpi" name="epistemicStatus" className="select" defaultValue="HYPOTHESE">
                  <option value="HYPOTHESE">{epistemicLabel.HYPOTHESE}</option>
                  <option value="AUSSAGE_WIEDERGEGEBEN">{epistemicLabel.AUSSAGE_WIEDERGEGEBEN}</option>
                  <option value="SACHVERHALT_BESTAETIGT">{epistemicLabel.SACHVERHALT_BESTAETIGT} (Quelle nötig)</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="pSource">Quelle</label>
                <select id="pSource" name="evidenceSourceId" className="select" defaultValue=""><option value="">–</option>{d.sources.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select>
              </div>
              <div className="sm:col-span-2"><label className="label" htmlFor="pNote">Anmerkung</label><input id="pNote" name="note" className="input" /></div>
              <div className="sm:col-span-2"><button className="btn" type="submit">Rolle speichern</button></div>
            </form>
          </details>
        )}
      </section>

      {/* Buying-Center-Berater (Etappe 17, Anker-/BD-Wunsch: Rollen durchgehen, beraten, Hinweise zum Lückenfüllen) */}
      <section className="card">
        <h2 className="font-semibold mb-2">Buying-Center-Berater</h2>
        <p className="muted text-sm mb-2">Geht die sechs Entscheidungsrollen dieser Chance durch und gibt bei Lücken einen Hinweis, wie sie zu schließen sind. Beruht auf dem oben erfassten Buyingcenter – kein zweiter Datenbestand.</p>
        {bcProposalError && <p className="error text-sm" role="alert">{bcProposalError}</p>}
        <table className="list text-sm">
          <thead><tr><th>Rolle</th><th>Status</th><th>Person(en)</th></tr></thead>
          <tbody>
            {bc.roleStatus.map((r) => (
              <tr key={r.role}>
                <td>{r.label}</td>
                <td><Status label={r.state === "OFFEN" ? "offen" : r.state === "BESTAETIGT" ? "bestätigt" : "Hypothese"} /></td>
                <td>{r.participants.length ? r.participants.map((p) => p.name).join(", ") : <span className="muted">–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {bc.latest && (
          <div className="mt-4 border rounded-md p-3" style={{ borderColor: "var(--border)" }}>
            <div className="flex flex-wrap items-baseline gap-3">
              <div className="font-medium">Aktuelle Fassung {bc.latest.versionNo}</div>
              <span className="muted text-sm">vom {fmtDate(bc.latest.createdAt)}{bc.latest.aiJobId ? " · mit KI-Vorschlag" : ""}</span>
            </div>
            <p className="text-sm mt-2" style={{ whiteSpace: "pre-wrap" }}>{bc.latest.summary}</p>
            {(bc.latest.roles as BuyingCenterProposal["roles"]).length > 0 && (
              <ul className="text-sm mt-2 space-y-1">
                {(bc.latest.roles as BuyingCenterProposal["roles"]).map((r, i) => (
                  <li key={i}><strong>{decisionRoleLabel[r.role] ?? r.role}:</strong> {r.hint}{r.proposedPersonName && <span className="muted"> – Vorschlag: {r.proposedPersonName}</span>}</li>
                ))}
              </ul>
            )}
            {bc.latest.note && <p className="muted text-xs mt-2">Notiz: {bc.latest.note}</p>}
          </div>
        )}

        {bc.canEdit && !closed && (
          <div className="mt-4">
            <div className="flex flex-wrap items-baseline gap-3 mb-2">
              <span className="muted text-sm">{bcDraftNote}</span>
              {!sp.bcberater && <Link href={`/bedarfe/${id}?bcberater=1`} className="btn btn-secondary btn-small ml-auto">Vorschlag der KI einholen</Link>}
            </div>
            <details>
              <summary>Neue Fassung erfassen</summary>
              <form action={saveBuyingCenterAdviceAction} className="mt-2 grid gap-4 text-sm">
                <input type="hidden" name="opportunityId" value={id} />
                {bcAiJobId && <input type="hidden" name="aiJobId" value={bcAiJobId} />}
                <div>
                  <label className="label" htmlFor="bcSummary">Lage des Buyingcenters (belegt / vermutlich trennen)</label>
                  <textarea id="bcSummary" name="summary" className="textarea" required minLength={10} defaultValue={bcDraft.summary} rows={3} />
                </div>
                <div>
                  <div className="label">Hinweis je Rolle (leer lassen = weglassen)</div>
                  <div className="space-y-3">
                    {decisionRoleValues.map((role) => {
                      const h = bcHintByRole.get(role);
                      const status = bc.roleStatus.find((r) => r.role === role);
                      return (
                        <div key={role} className="grid sm:grid-cols-12 gap-2 items-start">
                          <div className="sm:col-span-3 text-sm"><strong>{decisionRoleLabel[role] ?? role}</strong> <span className="muted">({status?.state === "OFFEN" ? "offen" : status?.state === "BESTAETIGT" ? "bestätigt" : "Hypothese"})</span></div>
                          <textarea name={`role_${role}_hint`} className="textarea sm:col-span-6" rows={2} placeholder="Hinweis zum Lückenfüllen" defaultValue={h?.hint ?? ""} maxLength={600} />
                          <input name={`role_${role}_person`} className="input sm:col-span-3" placeholder="Vorschlag Person (optional)" defaultValue={h?.proposedPersonName ?? ""} maxLength={200} />
                          <input type="hidden" name={`role_${role}_evidence`} value={h?.evidenceQuote ?? ""} />
                          {h?.evidenceQuote && <div className="muted text-xs sm:col-span-12">Textstelle: „{h.evidenceQuote.slice(0, 140)}“</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <div className="label">Offene Fragen</div>
                  <div className="space-y-2">{bcQuestions.map((q, k) => <input key={k} name={`openQuestions.${k}.text`} className="input" placeholder={`Frage ${k + 1}`} defaultValue={q} maxLength={300} />)}</div>
                </div>
                <div>
                  <label className="label" htmlFor="bcNote">Notiz zur Fassung (optional)</label>
                  <input id="bcNote" name="note" className="input" maxLength={600} />
                </div>
                <div><button className="btn" type="submit">Fassung speichern</button> <span className="muted text-xs ml-2">Es entsteht immer eine neue Version; frühere bleiben nachlesbar.</span></div>
              </form>
            </details>
          </div>
        )}

        {bc.versions.length > 1 && (
          <details className="mt-3">
            <summary>Frühere Fassungen ({bc.versions.length - 1})</summary>
            <ul className="mt-2 space-y-3 text-sm">
              {bc.versions.slice(1).map((v) => (
                <li key={v.id}>
                  <div className="font-medium">Fassung {v.versionNo} · {fmtDate(v.createdAt)}</div>
                  <p style={{ whiteSpace: "pre-wrap" }}>{v.summary}</p>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* MEDDPICC (9.4) */}
      <section className="card">
        <h2 className="font-semibold mb-2">Qualifizierungshilfe (MEDDPICC) – optional</h2>
        <p className="muted text-sm mb-2">Gezielte Hilfe bei Komplexität. Keine Pflicht vor einer Profilvorstellung, keine Bewertung, keine erfundenen Werte oder zugespitzter Leidensdruck.</p>
        {canEdit && !closed ? (
          <form action={saveMeddpiccAction} className="grid sm:grid-cols-2 gap-3">
            <input type="hidden" name="opportunityId" value={opp.id} />
            <input type="hidden" name="version" value={opp.version} />
            {MEDDPICC_KEYS.map(([k, label]) => (
              <div key={k}><label className="label" htmlFor={`md-${k}`}>{label}</label><input id={`md-${k}`} name={k} className="input" defaultValue={md[k] ?? ""} /></div>
            ))}
            <div className="sm:col-span-2">
              <SuggestButton kind="MEDDPICC" opportunityId={opp.id} setupId={ctx.setup.id} fields={MEDDPICC_KEYS.map(([k, label]) => ({ name: k, label }))} />
            </div>
            <div className="sm:col-span-2"><button className="btn btn-secondary" type="submit">Speichern</button></div>
          </form>
        ) : (
          <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">{MEDDPICC_KEYS.map(([k, label]) => <div key={k}><dt className="muted">{label}</dt><dd>{md[k] ?? "–"}</dd></div>)}</dl>
        )}
      </section>

      {/* Angebote (F09, F10) */}
      <section className="card">
        <h2 className="font-semibold mb-2">Angebote / Profilvorstellungen ({d.offers.length})</h2>
        <p className="muted text-sm mb-2">„Tatsächlich vorgestellt“ setzt ein manuell bestätigtes Vorstellungsereignis mit Beleg voraus – ein Entwurf genügt nicht. Ein akzeptiertes Angebot ist noch kein Auftrag.</p>
        {d.offers.length === 0 ? <p className="muted text-sm">Noch kein Angebot.</p> : (
          <ul className="space-y-3">
            {d.offers.map((o) => {
              const refs = d.profileRefs.filter((r) => o.profileReferenceIds.includes(r.id));
              const final = o.status === "AKZEPTIERT" || o.status === "ABGELEHNT" || o.status === "ZURUECKGEZOGEN";
              return (
                <li key={o.id} className="border rounded-md p-3 text-sm" style={{ borderColor: "var(--border)" }}>
                  <div className="flex flex-wrap gap-2 items-baseline"><strong>{o.title}</strong><Status label={offerStatusLabel[o.status] ?? o.status} /><span className="muted">Fassung {o.versionNo} · {name(o.createdBy)} · {fmtDateTime(o.createdAt)}</span></div>
                  {o.summary && <p className="mt-1 whitespace-pre-wrap">{o.summary}</p>}
                  <p className="muted mt-1">Profilreferenzen: {refs.length ? refs.map((r) => r.label).join("; ") : "keine"}{o.artifactVersionId && <> · <Link href={`/artefakte/${o.artifactVersionId}`}>Kundentext</Link></>}</p>
                  {o.presentedAt && <p className="mt-1">Vorgestellt am {fmtDateTime(o.presentedAt)} an {o.presentedTo}{o.presentedSourceId && <> · <Link href={`/quellen/${o.presentedSourceId}`}>Beleg</Link></>}</p>}
                  {o.feedbackNote && <p className="mt-1">Rückmeldung: {o.feedbackNote}</p>}
                  {o.statusReason && <p className="muted mt-1">Grund: {o.statusReason}</p>}
                  {canEdit && !closed && !final && (
                    <div className="mt-2 space-y-2">
                      {o.status === "ENTWURF" && (
                        <form action={changeOfferStatusAction} className="flex gap-2">
                          <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="offerId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                          <button className="btn btn-small" name="status" value="GEPRUEFT">Als geprüft markieren</button>
                          <input name="note" className="input" style={{ width: "16rem" }} placeholder="Grund (bei Zurückziehen)" aria-label="Grund" />
                          <button className="btn btn-secondary btn-small" name="status" value="ZURUECKGEZOGEN">Zurückziehen</button>
                        </form>
                      )}
                      {o.status === "GEPRUEFT" && (
                        <details>
                          <summary>Vorstellungsereignis bestätigen</summary>
                          <form action={presentOfferAction} className="mt-2 grid sm:grid-cols-2 gap-3">
                            <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="offerId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                            <div><label className="label" htmlFor={`pt-${o.id}`}>Vorgestellt an (Personen/Funktionen)</label><input id={`pt-${o.id}`} name="presentedTo" className="input" required minLength={3} /></div>
                            <div><label className="label" htmlFor={`pa-${o.id}`}>Zeitpunkt</label><input id={`pa-${o.id}`} name="presentedAt" type="datetime-local" className="input" /></div>
                            <EvidenceFields prefix={`pres-${o.id}`} sources={d.sources} label="Versand-/Vorstellungsbeleg" />
                            <div className="sm:col-span-2"><button className="btn" type="submit">Als tatsächlich vorgestellt festhalten</button></div>
                          </form>
                        </details>
                      )}
                      {(o.status === "VORGESTELLT" || o.status === "RUECKMELDUNG_OFFEN") && (
                        <form action={changeOfferStatusAction} className="flex flex-wrap gap-2 items-end">
                          <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="offerId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                          <input name="note" className="input" style={{ width: "22rem" }} placeholder="Rückmeldung des Kunden / Grund" aria-label="Rückmeldung" />
                          {o.status === "VORGESTELLT" && <button className="btn btn-secondary btn-small" name="status" value="RUECKMELDUNG_OFFEN">Rückmeldung offen</button>}
                          <button className="btn btn-small" name="status" value="AKZEPTIERT">Akzeptiert</button>
                          <button className="btn btn-secondary btn-small" name="status" value="ABGELEHNT">Abgelehnt</button>
                          <button className="btn btn-secondary btn-small" name="status" value="ZURUECKGEZOGEN">Zurückgezogen</button>
                        </form>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && !closed && opp.status !== "BEAUFTRAGT" && (
          <details className="mt-3">
            <summary>Angebot anlegen (Entwurf)</summary>
            <form action={createOfferAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="opportunityId" value={opp.id} />
              <div className="sm:col-span-2"><label className="label" htmlFor="ofTitle">Titel</label><input id="ofTitle" name="title" className="input" required minLength={3} /></div>
              <div className="sm:col-span-2"><label className="label" htmlFor="ofSummary">Kurzinhalt (intern; Kundentext als Artefakt A9 Profilangebot)</label><textarea id="ofSummary" name="summary" className="textarea" rows={3} /></div>
              <fieldset className="sm:col-span-2">
                <legend className="label">Freigegebene Profilreferenzen</legend>
                {d.profileRefs.length === 0 ? <p className="muted text-sm">Keine Profilreferenzen vorhanden – anlegen unter <Link href="/einstellungen">Einstellungen</Link> (BD/Principal/CEO).</p> : (
                  <div className="flex flex-wrap gap-3 text-sm">{d.profileRefs.map((r) => <label key={r.id} className="flex items-center gap-1"><input type="checkbox" name="profileReferenceIds" value={r.id} /> {r.label}</label>)}</div>
                )}
              </fieldset>
              <div className="sm:col-span-2"><button className="btn" type="submit">Angebot anlegen</button></div>
            </form>
          </details>
        )}
      </section>

      {/* Aufträge und Startvoraussetzungen (9.3) */}
      <section className="card">
        <h2 className="font-semibold mb-2">Auftrag und Einsatz ({d.orders.length})</h2>
        <p className="muted text-sm mb-2">„Beauftragung bestätigt“ braucht prüfbare Bestell-/Vertragsnachweise. „Startbereit“ braucht den bestätigten Stand aller Startvoraussetzungen – eine leere Liste gilt nicht. „Gestartet“ ist ein bestätigtes Ereignis. Ohne freigegebene Regelkonfiguration wird hier nur der dokumentierte Stand gezeigt, keine produktive Einsatzfreigabe behauptet.</p>
        {d.orders.length === 0 ? <p className="muted text-sm">Noch kein Auftrag.</p> : (
          <ul className="space-y-3">
            {d.orders.map((o) => {
              const cancelled = o.status === "BEENDET_STORNIERT";
              const confirmed = o.status === "BEAUFTRAGUNG_BESTAETIGT";
              return (
                <li key={o.id} className="border rounded-md p-3 text-sm" style={{ borderColor: "var(--border)" }}>
                  <div className="flex flex-wrap gap-2 items-baseline"><strong>Auftrag {o.orderReference ?? "(Referenz offen)"}</strong><Status label={orderStatusLabel[o.status] ?? o.status} /><Status label={engagementStatusLabel[o.engagementStatus] ?? o.engagementStatus} /><span className="muted">geplant {fmtDate(o.plannedStart)} – {fmtDate(o.plannedEnd)}</span></div>
                  {o.confirmedAt && <p className="mt-1">Beauftragung bestätigt am {fmtDateTime(o.confirmedAt)} durch {name(o.confirmedBy)}{o.evidenceSourceId && <> · <Link href={`/quellen/${o.evidenceSourceId}`}>Nachweis</Link></>}{o.evidenceNote && <> · {o.evidenceNote}</>}</p>}
                  {o.startedAt && <p className="mt-1">Gestartet am {fmtDateTime(o.startedAt)}{o.statusReason && <> · {o.statusReason}</>}</p>}
                  {!o.startedAt && o.statusReason && <p className="muted mt-1">{o.statusReason}</p>}

                  <h3 className="font-semibold mt-3 mb-1">Startvoraussetzungen ({o.requirements.length})</h3>
                  {o.requirements.length === 0 ? <p className="muted">Keine erfasst – ohne erfasste und bestätigte Voraussetzungen keine Startfreigabe.</p> : (
                    <ul className="space-y-1">
                      {o.requirements.map((r) => (
                        <li key={r.id} className="flex flex-wrap gap-2 items-baseline">
                          <span>{r.requirement}</span><Status label={requirementStatusLabel[r.status] ?? r.status} />
                          <span className="muted">{r.checkedBy && `prüft: ${r.checkedBy}`}{r.policyRef && ` · Regel: ${r.policyRef}`}{r.evidenceSourceId && <> · <Link href={`/quellen/${r.evidenceSourceId}`}>Nachweis</Link></>}{r.evidenceNote && ` · ${r.evidenceNote}`}{r.confirmedAt && ` · bestätigt ${fmtDateTime(r.confirmedAt)} von ${name(r.confirmedBy)}`}</span>
                          {canEdit && !cancelled && o.engagementStatus !== "GESTARTET" && o.engagementStatus !== "BEENDET" && r.status !== "BESTAETIGT" && (
                            <details className="w-full">
                              <summary className="muted">Nachweis / Stand setzen</summary>
                              <form action={setRequirementStatusAction} className="mt-1 grid sm:grid-cols-2 gap-2">
                                <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="requirementId" value={r.id} /><input type="hidden" name="version" value={r.version} />
                                <div>
                                  <label className="label" htmlFor={`rs-${r.id}`}>Stand</label>
                                  <select id={`rs-${r.id}`} name="status" className="select" defaultValue="BESTAETIGT">
                                    <option value="NACHWEIS_VORGELEGT">Nachweis vorgelegt (Quelle nötig)</option>
                                    <option value="BESTAETIGT">Bestätigt (Quelle nötig)</option>
                                    <option value="NICHT_ANWENDBAR">Nicht anwendbar (Begründung nötig)</option>
                                  </select>
                                </div>
                                <div><label className="label" htmlFor={`rn-${r.id}`}>Anmerkung / Begründung</label><input id={`rn-${r.id}`} name="evidenceNote" className="input" /></div>
                                <EvidenceFields prefix={`req-${r.id}`} sources={d.sources} label="Nachweis" />
                                <div className="sm:col-span-2"><button className="btn btn-small" type="submit">Speichern</button></div>
                              </form>
                            </details>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {canEdit && !cancelled && (
                    <div className="mt-3 space-y-2">
                      {!confirmed && (
                        <details>
                          <summary>Beauftragung bestätigen (mit Nachweis)</summary>
                          <form action={confirmOrderAction} className="mt-2 grid sm:grid-cols-2 gap-3">
                            <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="orderId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                            <div><label className="label" htmlFor={`or-${o.id}`}>Bestell-/Vertragsreferenz</label><input id={`or-${o.id}`} name="orderReference" className="input" required minLength={2} defaultValue={o.orderReference ?? ""} /></div>
                            <div><label className="label" htmlFor={`on-${o.id}`}>Anmerkung</label><input id={`on-${o.id}`} name="evidenceNote" className="input" /></div>
                            <EvidenceFields prefix={`ord-${o.id}`} sources={d.sources} label="Bestell-/Vertragsnachweis" />
                            <div className="sm:col-span-2"><button className="btn" type="submit">Beauftragung bestätigen</button></div>
                          </form>
                        </details>
                      )}
                      {!confirmed && (
                        <form action={orderEvidenceIncompleteAction} className="flex flex-wrap gap-2 items-end">
                          <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="orderId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                          <input name="note" className="input" style={{ width: "22rem" }} placeholder="Welcher Nachweis fehlt?" aria-label="Fehlender Nachweis" />
                          <button className="btn btn-secondary btn-small" type="submit">Nachweise unvollständig</button>
                        </form>
                      )}
                      {o.engagementStatus !== "GESTARTET" && o.engagementStatus !== "BEENDET" && (
                        <details>
                          <summary>Startvoraussetzung erfassen</summary>
                          <form action={addStartRequirementAction} className="mt-2 grid sm:grid-cols-3 gap-3">
                            <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="orderId" value={o.id} />
                            <div><label className="label" htmlFor={`rq-${o.id}`}>Anforderung</label><input id={`rq-${o.id}`} name="requirement" className="input" required minLength={3} /></div>
                            <div><label className="label" htmlFor={`rc-${o.id}`}>Prüfende Stelle</label><input id={`rc-${o.id}`} name="checkedBy" className="input" /></div>
                            <div><label className="label" htmlFor={`rp-${o.id}`}>Regelbezug (falls freigegeben)</label><input id={`rp-${o.id}`} name="policyRef" className="input" /></div>
                            <div className="sm:col-span-3"><button className="btn btn-small" type="submit">Hinzufügen</button></div>
                          </form>
                        </details>
                      )}
                      {confirmed && o.engagementStatus === "GEPLANT" && (
                        <form action={markReadyAction}>
                          <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="orderId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                          <button className="btn" type="submit">Startbereit setzen (prüft alle Startvoraussetzungen)</button>
                        </form>
                      )}
                      {o.engagementStatus === "STARTBEREIT" && (
                        <form action={markStartedAction} className="flex flex-wrap gap-2 items-end">
                          <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="orderId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                          <div><label className="label" htmlFor={`sa-${o.id}`}>Startzeitpunkt</label><input id={`sa-${o.id}`} name="startedAt" type="datetime-local" className="input" /></div>
                          <div><label className="label" htmlFor={`sn-${o.id}`}>Bestätigung des Startereignisses</label><input id={`sn-${o.id}`} name="note" className="input" style={{ width: "22rem" }} required minLength={3} placeholder="z. B. Kick-off mit … durchgeführt" /></div>
                          <button className="btn" type="submit">Start bestätigen</button>
                        </form>
                      )}
                      <form action={cancelOrderAction} className="flex flex-wrap gap-2 items-end">
                        <input type="hidden" name="opportunityId" value={opp.id} /><input type="hidden" name="orderId" value={o.id} /><input type="hidden" name="version" value={o.version} />
                        <input name="reason" className="input" style={{ width: "22rem" }} placeholder="Grund" aria-label="Grund für Beenden/Stornieren" />
                        <button className="btn btn-secondary btn-small" type="submit">Auftrag beenden / stornieren</button>
                      </form>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && !closed && opp.status !== "ZURUECKGESTELLT" && (
          <details className="mt-3">
            <summary>Auftrag anlegen (in Vorbereitung)</summary>
            <form action={createOrderAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="opportunityId" value={opp.id} />
              <div>
                <label className="label" htmlFor="odOffer">Bezug auf Angebot (optional)</label>
                <select id="odOffer" name="offerId" className="select" defaultValue=""><option value="">–</option>{d.offers.map((o) => <option key={o.id} value={o.id}>{o.title} (Fassung {o.versionNo})</option>)}</select>
              </div>
              <div><label className="label" htmlFor="odRef">Bestell-/Vertragsreferenz (falls schon bekannt)</label><input id="odRef" name="orderReference" className="input" /></div>
              <div><label className="label" htmlFor="odStart">Geplanter Start</label><input id="odStart" name="plannedStart" type="date" className="input" /></div>
              <div><label className="label" htmlFor="odEnd">Geplantes Ende</label><input id="odEnd" name="plannedEnd" type="date" className="input" /></div>
              <div className="sm:col-span-2"><button className="btn" type="submit">Auftrag anlegen</button></div>
            </form>
          </details>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Passende Artefakte</h2>
        <p className="text-sm">Klärung der Chance, Profilvorstellung und Auftrags-/Startunterlagen entstehen als Textentwürfe im Setup: <Link href={`/setups/${ctx.setup.id}/artefakte`}>Artefakte des Setups →</Link> (A7 Bedarfsbriefing, A8 Risiko-/Qualifizierungsnotiz, A9 Profilangebot, A10 Auswahl-/Entscheidungsstand, A11 Auftrags-/Startübergabe, A12 Verlängerung/Entwicklung). Kundentexte enthalten keine internen Einordnungen.</p>
      </section>

      {/* Persönlicher KI-Berater für diese Chance (Etappe 15, BD-Wunsch: „nächste Schritte zur Konvertierung“) */}
      <section className="card">
        <h2 className="font-semibold mb-2">Persönlicher KI-Berater für diese Chance</h2>
        {adviceProposalError && <p className="error text-sm" role="alert">{adviceProposalError}</p>}
        <p className="text-sm"><span className="muted">Nächster Schritt zur Konvertierung: </span>{advice.analysis.nextStep}</p>
        <div className="grid sm:grid-cols-3 gap-4 mt-3 text-sm">
          <div><div className="font-medium mb-1">Blockiert</div>{advice.analysis.blockers.length === 0 ? <p className="muted">Nichts Dokumentiertes.</p> : <ul className="space-y-1">{advice.analysis.blockers.map((b, i) => <li key={i} style={{ color: "#a12b1e" }}>{b}</li>)}</ul>}</div>
          <div><div className="font-medium mb-1">Was fehlt</div>{advice.analysis.missing.length === 0 ? <p className="muted">Grundlagen vollständig.</p> : <ul className="space-y-1">{advice.analysis.missing.map((m, i) => <li key={i}>{m}</li>)}</ul>}</div>
          <div><div className="font-medium mb-1">Naheliegende Züge</div>{advice.analysis.moves.length === 0 ? <p className="muted">Nichts vorbereitet.</p> : <ul className="space-y-1">{advice.analysis.moves.map((m, i) => <li key={i}>{m}</li>)}</ul>}</div>
        </div>

        {advice.latest && (
          <div className="mt-4 border rounded-md p-3" style={{ borderColor: "var(--border)" }}>
            <div className="flex flex-wrap items-baseline gap-3">
              <div className="font-medium">Aktuelle Fassung {advice.latest.versionNo}</div>
              <span className="muted text-sm">vom {fmtDate(advice.latest.createdAt)}{advice.latest.aiJobId ? " · mit KI-Vorschlag" : ""}</span>
            </div>
            <p className="text-sm mt-2" style={{ whiteSpace: "pre-wrap" }}>{advice.latest.summary}</p>
            <p className="text-sm mt-2"><span className="muted">Nächster Schritt: </span>{advice.latest.nextStep}</p>
            {(advice.latest.moves as StrategyMove[]).length > 0 && (
              <ol className="text-sm mt-2 space-y-1 list-decimal ml-5">
                {(advice.latest.moves as StrategyMove[]).map((m, i) => (
                  <li key={i}><strong>{m.title}</strong> <span className="status">{m.ownerRole}</span>{m.why && <span className="muted"> – {m.why}</span>}</li>
                ))}
              </ol>
            )}
            {advice.latest.note && <p className="muted text-xs mt-2">Notiz: {advice.latest.note}</p>}
          </div>
        )}

        {advice.canEdit && (
          <div className="mt-4">
            <div className="flex flex-wrap items-baseline gap-3 mb-2">
              <span className="muted text-sm">{adviceDraftNote}</span>
              {!sp.berater && <Link href={`/bedarfe/${id}?berater=1`} className="btn btn-secondary btn-small ml-auto">Vorschlag der KI einholen</Link>}
            </div>
            <details>
              <summary>Neue Fassung erfassen</summary>
              <form action={saveOpportunityAdviceAction} className="mt-2 grid gap-4 text-sm">
                <input type="hidden" name="opportunityId" value={id} />
                {adviceAiJobId && <input type="hidden" name="aiJobId" value={adviceAiJobId} />}
                <div>
                  <label className="label" htmlFor="adSummary">Lage dieser Chance (belegt / vermutlich trennen)</label>
                  <textarea id="adSummary" name="summary" className="textarea" required minLength={10} defaultValue={adviceDraft.summary} rows={4} />
                </div>
                <div>
                  <label className="label" htmlFor="adNextStep">Nächster Schritt zur Konvertierung</label>
                  <input id="adNextStep" name="nextStep" className="input" required minLength={5} defaultValue={adviceDraft.nextStep} />
                </div>
                <div>
                  <div className="label">Züge (leer lassen = weglassen)</div>
                  <div className="space-y-2">
                    {adviceMoves.map((m, k) => (
                      <div key={k} className="grid sm:grid-cols-12 gap-2 items-start">
                        <input name={`moves.${k}.title`} className="input sm:col-span-5" placeholder={`Zug ${k + 1}`} defaultValue={m.title} maxLength={200} />
                        <input name={`moves.${k}.why`} className="input sm:col-span-4" placeholder="Warum jetzt" defaultValue={m.why} maxLength={600} />
                        <select name={`moves.${k}.ownerRole`} className="select sm:col-span-2" defaultValue={m.ownerRole}>
                          <option value="BD">BD</option><option value="ANKER">Anker</option><option value="PRINCIPAL">Principal</option>
                        </select>
                        <input type="hidden" name={`moves.${k}.evidenceQuote`} value={m.evidenceQuote} />
                        {m.evidenceQuote && <div className="muted text-xs sm:col-span-12">Textstelle: „{m.evidenceQuote.slice(0, 140)}“</div>}
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="label">Risiken (belegt)</div>
                  <div className="space-y-2">
                    {adviceRisks.map((r, k) => (
                      <div key={k}>
                        <input name={`risks.${k}.text`} className="input" placeholder={`Risiko ${k + 1}`} defaultValue={r.text} maxLength={400} />
                        <input type="hidden" name={`risks.${k}.evidenceQuote`} value={r.evidenceQuote} />
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="label">Offene Fragen</div>
                  <div className="space-y-2">{adviceQuestions.map((q, k) => <input key={k} name={`openQuestions.${k}.text`} className="input" placeholder={`Frage ${k + 1}`} defaultValue={q} maxLength={300} />)}</div>
                </div>
                <div>
                  <label className="label" htmlFor="adNote">Notiz zur Fassung (optional)</label>
                  <input id="adNote" name="note" className="input" maxLength={600} />
                </div>
                <div><button className="btn" type="submit">Fassung speichern</button> <span className="muted text-xs ml-2">Es entsteht immer eine neue Version; frühere bleiben nachlesbar.</span></div>
              </form>
            </details>
          </div>
        )}

        {advice.versions.length > 1 && (
          <details className="mt-3">
            <summary>Frühere Fassungen ({advice.versions.length - 1})</summary>
            <ul className="mt-2 space-y-3 text-sm">
              {advice.versions.slice(1).map((v) => (
                <li key={v.id}>
                  <div className="font-medium">Fassung {v.versionNo} · {fmtDate(v.createdAt)}</div>
                  <p style={{ whiteSpace: "pre-wrap" }}>{v.summary}</p>
                  <p className="muted">Nächster Schritt damals: {v.nextStep}</p>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}

function adviceFromRow(r: OpportunityAdviceRow): StrategyProposal {
  return { summary: r.summary, nextStep: r.nextStep, moves: (r.moves as StrategyMove[]).map((m) => ({ title: m.title, why: m.why ?? "", ownerRole: m.ownerRole ?? "BD", evidenceQuote: m.evidenceQuote ?? "" })), risks: (r.risks as { text: string; evidenceQuote: string }[]) ?? [], openQuestions: (r.openQuestions as string[]) ?? [] };
}

function bcAdviceFromRow(r: BuyingCenterAdviceRow): BuyingCenterProposal {
  return { summary: r.summary, roles: (r.roles as BuyingCenterProposal["roles"]) ?? [], openQuestions: (r.openQuestions as string[]) ?? [] };
}
