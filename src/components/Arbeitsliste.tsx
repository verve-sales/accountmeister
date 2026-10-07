import Link from "next/link";
import type { ReactNode } from "react";
import { fmtDate, actionStatusLabel, handoverStatusLabel, supportStatusLabel } from "@/lib/labels";
import { Status } from "./Status";
import { WorkList } from "./Work";
import { SuggestionCard } from "./SuggestionCard";
import { HintButtons } from "./MocoHints";
import { RenewalDecisionCard, RenewalStartCard } from "./Renewal";
import type { RenewalCard } from "@/modules/engagements/care";
import type { listMyCheckins } from "@/modules/engagements/care";
import type { listMyOpenActions } from "@/modules/actions/service";
import type { listMyHandovers } from "@/modules/handovers/service";
import type { listMySupportRequests } from "@/modules/leadership/service";
import type { listMySuggestions } from "@/modules/suggestions/service";
import type { WorkItemView } from "@/modules/work/service";
import type { HintKind } from "@/modules/moco/sync";
import { hintKindLabel } from "@/modules/moco/sync";
import { changeActionStatusAction, checkinAction, respondHandoverAction, respondSupportRequestAction } from "@/app/actions";

/**
 * Startseite als Arbeitsliste (Etappe 33, Zielbild Bedienung): drei Gruppen – Entscheidungen, Aufgaben, Vorschläge –
 * je Gruppe höchstens fünf Karten sichtbar, der Rest eingeklappt. Hinter den Karten stehen weiterhin die bestehenden
 * Objekte (Verlängerung, Übergabe, Unterstützungsauftrag, Vorgang, Check-in, Aktion, Vorschlagskarte, Moco-Hinweis).
 */

export type CheckinItem = Awaited<ReturnType<typeof listMyCheckins>>[number];
type ActionItem = Awaited<ReturnType<typeof listMyOpenActions>>[number];
type HandoverItem = Awaited<ReturnType<typeof listMyHandovers>>[number];
type SupportItem = Awaited<ReturnType<typeof listMySupportRequests>>[number];
type SuggestionItem = Awaited<ReturnType<typeof listMySuggestions>>[number];
export type HintItem = { id: string; kind: string; title: string; createdAt: Date; subjectType: string; subjectId: string | null };

const RED = "#c0392b";
const AMBER = "#b7791f";
const SHOW = 5;

/** Zeigt die ersten N Einträge, den Rest eingeklappt. */
function Fold({ items, label }: { items: ReactNode[]; label: string }) {
  if (!items.length) return null;
  const head = items.slice(0, SHOW);
  const rest = items.slice(SHOW);
  return (
    <>
      <ul className="space-y-2">{head}</ul>
      {rest.length > 0 && (
        <details className="mt-2">
          <summary className="text-sm muted">+ {rest.length} weitere {label}</summary>
          <ul className="space-y-2 mt-2">{rest}</ul>
        </details>
      )}
    </>
  );
}

export function CheckinRow({ c, back }: { c: CheckinItem; back: string }) {
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm" style={{ borderLeft: `3px solid ${c.overdue ? RED : AMBER}`, paddingLeft: ".6rem" }}>
      <div style={{ minWidth: "16rem", flex: "1 1 16rem" }}>
        <Link href={`/einsaetze/${c.engagementId}#checkins`}><strong>{c.personName}</strong></Link> <span className="muted">bei {c.accountName}</span>
        <div className="muted text-xs">Check-in {c.side === "KUNDE" ? "Kunde" : "Freelancer"} · {c.engagementTitle} · fällig {fmtDate(c.dueDate)}{c.overdue ? " (überfällig)" : ""}</div>
      </div>
      <form action={checkinAction} className="flex flex-wrap gap-1 items-center">
        <input type="hidden" name="checkinId" value={c.id} /><input type="hidden" name="version" value={c.version} /><input type="hidden" name="back" value={back} /><input type="hidden" name="action" value="ERLEDIGEN" />
        <span className="muted text-xs">heute geführt:</span>
        <button className="btn btn-small" type="submit" name="mood" value="POSITIV" style={{ background: "#2f7d32" }}>positiv</button>
        <button className="btn btn-small" type="submit" name="mood" value="MITTEL" style={{ background: AMBER }}>mittel</button>
        <button className="btn btn-small" type="submit" name="mood" value="NEGATIV" style={{ background: RED }}>negativ</button>
        <details className="inline">
          <summary className="text-xs muted" style={{ cursor: "pointer" }}>mehr</summary>
          <div className="flex flex-wrap gap-1 items-center mt-1">
            <input type="datetime-local" name="heldAt" className="input" aria-label="Gesprächstermin" />
            <input name="note" className="input" placeholder="Ergebnis" aria-label="Ergebnis" style={{ minWidth: 200 }} />
            <input name="salesHint" className="input" placeholder="Sales-Hinweis (optional)" aria-label="Sales-Hinweis" />
            <button className="btn btn-secondary btn-small" type="submit">Mit Details erledigen</button>
          </div>
        </details>
      </form>
    </li>
  );
}

function HandoverCard({ h, back }: { h: HandoverItem; back: string }) {
  return (
    <li className="card text-sm" style={{ borderLeft: `4px solid ${AMBER}` }}>
      <div className="flex flex-wrap gap-2 items-baseline">
        <strong>Übernahme: {h.responsibility}</strong>
        <Status label={handoverStatusLabel[h.status] ?? h.status} />
        <span className="muted">von {h.senderName} · Termin {fmtDate(h.dueDate)}{h.setupId && <> · <Link href={`/setups/${h.setupId}`}>Setup</Link></>}</span>
      </div>
      <p className="mt-1">{h.context}</p>
      <form action={respondHandoverAction} className="mt-2 flex flex-wrap gap-2 items-end">
        <input type="hidden" name="handoverId" value={h.id} /><input type="hidden" name="version" value={h.version} /><input type="hidden" name="back" value={back} />
        <input name="responseNote" className="input" style={{ minWidth: 220 }} placeholder="Notiz (bei Rückgabe erforderlich)" aria-label="Notiz" />
        <button className="btn btn-small" type="submit" name="decision" value="ANNEHMEN">Annehmen</button>
        <button className="btn btn-secondary btn-small" type="submit" name="decision" value="ZURUECKGEBEN">Zurückgeben</button>
      </form>
    </li>
  );
}

function SupportCard({ s, back }: { s: SupportItem; back: string }) {
  return (
    <li className="card text-sm" style={{ borderLeft: `4px solid ${s.isAddressee ? AMBER : "var(--border)"}` }}>
      <div className="flex flex-wrap gap-2 items-baseline"><strong>{s.task}</strong><Status label={supportStatusLabel[s.status] ?? s.status} /><span className="muted">{s.isAddressee ? `von ${s.requesterName}` : `an ${s.addresseeName}`}{s.setupName && <> · <Link href={`/setups/${s.setupId}`}>{s.setupName}</Link></>}{s.dueDate && ` · bis ${fmtDate(s.dueDate)}`}</span></div>
      {s.context && <p className="muted mt-1">{s.context}</p>}
      <form action={respondSupportRequestAction} className="mt-2 flex flex-wrap gap-1 items-end">
        <input type="hidden" name="requestId" value={s.id} /><input type="hidden" name="version" value={s.version} /><input type="hidden" name="back" value={back} />
        <input name="note" className="input" style={{ width: "16rem" }} placeholder="Ergebnis / Begründung" aria-label="Ergebnis oder Begründung" />
        {s.isAddressee && s.status === "ANGEFRAGT" && <button className="btn btn-small" name="decision" value="ANNEHMEN">Annehmen</button>}
        {s.isAddressee && s.status === "ANGENOMMEN" && <button className="btn btn-small" name="decision" value="ERLEDIGEN">Ergebnis melden</button>}
        {s.isAddressee && <button className="btn btn-secondary btn-small" name="decision" value="ZURUECKGEBEN">Zurückgeben</button>}
        {s.isRequester && s.status === "ANGEFRAGT" && <button className="btn btn-secondary btn-small" name="decision" value="ZURUECKZIEHEN">Zurückziehen</button>}
      </form>
    </li>
  );
}

function ActionRow({ a, back, today }: { a: ActionItem; back: string; today: string }) {
  const overdue = !!a.dueDate && a.dueDate < today;
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm" style={{ borderLeft: `3px solid ${overdue ? RED : a.status === "VORGESCHLAGEN" ? AMBER : "var(--border)"}`, paddingLeft: ".6rem" }}>
      <div style={{ minWidth: "16rem", flex: "1 1 16rem" }}>
        <strong>{a.title}</strong>
        <div className="muted text-xs">{a.setupId ? <Link href={`/setups/${a.setupId}`}>{a.setupName}</Link> : "–"} · {actionStatusLabel[a.status] ?? a.status}{a.dueDate ? ` · fällig ${fmtDate(a.dueDate)}` : ""}{overdue ? " (überfällig)" : ""}</div>
      </div>
      <form action={changeActionStatusAction} className="flex flex-wrap gap-1 items-center">
        <input type="hidden" name="actionId" value={a.id} /><input type="hidden" name="version" value={a.version} /><input type="hidden" name="back" value={back} />
        <input name="result" className="input" style={{ width: "11rem" }} placeholder="Ergebnis (optional)" aria-label="Ergebnis" />
        {a.status === "VORGESCHLAGEN" && <button className="btn btn-small" name="status" value="ANGENOMMEN">Annehmen</button>}
        {a.status !== "VORGESCHLAGEN" && <button className="btn btn-small" name="status" value="ERLEDIGT">Erledigt</button>}
        <button className="btn btn-secondary btn-small" name="status" value="VERWORFEN">Verwerfen</button>
      </form>
    </li>
  );
}

export function Entscheidungen({ renewals, handovers, support, review, back }: { renewals: RenewalCard[]; handovers: HandoverItem[]; support: SupportItem[]; review: WorkItemView[]; back: string }) {
  const items: ReactNode[] = [
    ...renewals.filter((c) => c.mode === "ENTSCHEIDEN").map((c) => <RenewalDecisionCard key={`r-${c.decisionId}`} c={c} back={back} />),
    ...handovers.map((h) => <HandoverCard key={`h-${h.id}`} h={h} back={back} />),
    ...support.filter((s) => s.isAddressee && s.status === "ANGEFRAGT").map((s) => <SupportCard key={`s-${s.id}`} s={s} back={back} />),
  ];
  const n = items.length + review.length;
  return (
    <section id="entscheidungen" className="space-y-2">
      <h2 className="font-semibold">Entscheidungen {n ? `(${n})` : ""}</h2>
      {n === 0 ? <p className="muted text-sm">Nichts zu entscheiden.</p> : <Fold items={items} label="Entscheidungen" />}
      {review.length > 0 && (
        <details open={items.length === 0}>
          <summary className="text-sm">Zur Prüfung bei mir ({review.length}) – von mir beauftragte Vorgänge, die als erledigt gemeldet sind</summary>
          <div className="mt-2"><WorkList items={review} empty="" perspective="requester" /></div>
        </details>
      )}
    </section>
  );
}

export function Aufgaben({ work, checkins, actions, renewals, support, back, today }: { work: WorkItemView[]; checkins: CheckinItem[]; actions: ActionItem[]; renewals: RenewalCard[]; support: SupportItem[]; back: string; today: string }) {
  const soonCheckins = checkins.filter((c) => c.overdue || c.dueDate <= addDays(today, 7));
  const laterCheckins = checkins.filter((c) => !soonCheckins.includes(c));
  const dueActions = actions.filter((a) => a.status === "VORGESCHLAGEN" || (a.dueDate && a.dueDate <= addDays(today, 7)));
  const laterActions = actions.filter((a) => !dueActions.includes(a));
  const starts = renewals.filter((c) => c.mode === "ANSTOSSEN");
  const mySupport = support.filter((s) => s.isAddressee && s.status === "ANGENOMMEN");
  const overdueWork = work.filter((w) => w.overdue || w.status === "ANGEFRAGT");
  const otherWork = work.filter((w) => !overdueWork.includes(w));
  const n = work.length + checkins.length + actions.length + starts.length + mySupport.length;
  const items: ReactNode[] = [
    ...soonCheckins.map((c) => <CheckinRow key={`c-${c.id}`} c={c} back={back} />),
    ...starts.map((c) => <RenewalStartCard key={`rs-${c.decisionId}`} c={c} back={back} />),
    ...mySupport.map((s) => <SupportCard key={`s-${s.id}`} s={s} back={back} />),
    ...dueActions.map((a) => <ActionRow key={`a-${a.id}`} a={a} back={back} today={today} />),
  ];
  return (
    <section id="aufgaben" className="space-y-2">
      <h2 className="font-semibold">Aufgaben {n ? `(${n})` : ""}</h2>
      {n === 0 && <p className="muted text-sm">Nichts fällig.</p>}
      {(overdueWork.length > 0 || otherWork.length > 0) && (
        <details open={overdueWork.length > 0}>
          <summary className="text-sm">Vorgänge bei mir ({work.length}){overdueWork.length ? <span style={{ color: RED, fontWeight: 600 }}> · {overdueWork.length} überfällig oder unbeantwortet</span> : null}</summary>
          <div className="mt-2"><WorkList items={[...overdueWork, ...otherWork].slice(0, 8)} empty="" perspective="assignee" />{work.length > 8 && <p className="text-xs mt-1"><Link href="/meine-arbeit?v=mir#vorgaenge">alle {work.length} Vorgänge</Link></p>}</div>
        </details>
      )}
      <Fold items={items} label="Aufgaben" />
      {(laterCheckins.length > 0 || laterActions.length > 0) && (
        <details>
          <summary className="text-sm muted">Später fällig ({laterCheckins.length + laterActions.length})</summary>
          <ul className="space-y-2 mt-2">
            {laterCheckins.map((c) => <CheckinRow key={`c-${c.id}`} c={c} back={back} />)}
            {laterActions.map((a) => <ActionRow key={`a-${a.id}`} a={a} back={back} today={today} />)}
          </ul>
        </details>
      )}
    </section>
  );
}

export function Vorschlaege({ suggestions, hints, userNames, users, back, aiEnabled }: { suggestions: SuggestionItem[]; hints: HintItem[]; userNames: Map<string, string>; users: { id: string; displayName: string }[]; back: string; aiEnabled: boolean }) {
  const items: ReactNode[] = [
    ...suggestions.map((x) => <li key={`v-${x.id}`}><SuggestionCard s={x} ownerName={x.proposedOwnerUserId ? userNames.get(x.proposedOwnerUserId) ?? null : null} canDecide back={back} users={users} /></li>),
    ...hints.map((h) => (
      <li key={`m-${h.id}`} className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="status">{hintKindLabel[h.kind as HintKind] ?? h.kind}</span>
        <span>{h.title}</span>
        {h.subjectType === "ENGAGEMENT" && h.subjectId && <Link href={`/einsaetze/${h.subjectId}`} className="text-xs">Einsatz</Link>}
        <HintButtons id={h.id} kind={h.kind as HintKind} back={back} />
      </li>
    )),
  ];
  return (
    <section id="vorschlaege" className="space-y-2">
      <h2 className="font-semibold">Vorschläge {items.length ? `(${items.length})` : ""}</h2>
      {items.length === 0 ? <p className="muted text-sm">{aiEnabled ? "Keine offenen Vorschläge." : "KI-Anbieter ist aus – Vorschläge entstehen nur aus Regeln (Moco-Hinweise)."}</p> : <Fold items={items} label="Vorschläge" />}
    </section>
  );
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
