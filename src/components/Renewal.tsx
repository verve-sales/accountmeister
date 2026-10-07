import Link from "next/link";
import { fmtDate } from "@/lib/labels";
import { plusDaysIso } from "@/modules/work/calendar";
import type { RenewalCard as Card } from "@/modules/engagements/care";
import { decideRenewalAction, startRenewalAction } from "@/app/actions";

const RED = "#c0392b";
const AMBER = "#b7791f";

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** „Verlängerung anstoßen“ – ein Datum, Konditionen unverändert als Vorgabe, optional Notiz (Use Case 1, Schritt 2). */
export function RenewalStartForm({ engagementId, currentEnd, back, compact = false, lastRates }: { engagementId: string; currentEnd: string | null; back: string; compact?: boolean; lastRates?: { ek: string | null; vk: string | null; unit: string } | null }) {
  const base = currentEnd ?? new Date().toISOString().slice(0, 10);
  const plus6 = addMonths(base, 6);
  const idp = `rs-${engagementId.slice(0, 6)}`;
  return (
    <form action={startRenewalAction} className={compact ? "flex flex-wrap items-end gap-2 text-sm" : "grid sm:grid-cols-4 gap-2 text-sm"}>
      <input type="hidden" name="engagementId" value={engagementId} />
      <input type="hidden" name="back" value={back} />
      <div>
        <label className="label" htmlFor={`${idp}-end`}>Neues Ende</label>
        <input id={`${idp}-end`} type="date" name="newEnd" className="input" required defaultValue={plus6} min={plusDaysIso(base, 1)} list={`${idp}-ends`} />
        <datalist id={`${idp}-ends`}>
          <option value={addMonths(base, 3)}>+3 Monate</option>
          <option value={plus6}>+6 Monate</option>
          <option value={addMonths(base, 12)}>+12 Monate</option>
        </datalist>
      </div>
      <div>
        <label className="label" htmlFor={`${idp}-cond`}>Konditionen</label>
        <select id={`${idp}-cond`} name="conditions" className="input" defaultValue="UNVERAENDERT">
          <option value="UNVERAENDERT">unverändert{lastRates && (lastRates.ek || lastRates.vk) ? ` (EK ${lastRates.ek ?? "–"} / VK ${lastRates.vk ?? "–"})` : ""}</option>
          <option value="NEU">neu (EK/VK unten)</option>
        </select>
      </div>
      {!compact && (
        <>
          <div><label className="label" htmlFor={`${idp}-ek`}>EK neu</label><input id={`${idp}-ek`} name="ek" className="input" inputMode="decimal" placeholder="nur bei „neu“" /></div>
          <div><label className="label" htmlFor={`${idp}-vk`}>VK neu</label><input id={`${idp}-vk`} name="vk" className="input" inputMode="decimal" placeholder="nur bei „neu“" /></div>
        </>
      )}
      <div className={compact ? "" : "sm:col-span-3"}>
        <label className="label" htmlFor={`${idp}-note`}>Notiz für den BD (optional)</label>
        <input id={`${idp}-note`} name="note" className="input" placeholder="z. B. Kunde hat mündlich zugesagt, Bestellung folgt" style={{ minWidth: compact ? 220 : undefined }} />
      </div>
      <div><button className="btn btn-small" type="submit">Verlängerung anstoßen</button></div>
    </form>
  );
}

/** Entscheidungskarte für BD/Principal/CEO: Bestätigen · Ablehnen · Weitergeben (Use Case 1, Schritt 3). */
export function RenewalDecisionCard({ c, back }: { c: Card; back: string }) {
  const urgent = c.daysToEnd !== null && c.daysToEnd <= 28;
  return (
    <li className="card" style={{ borderLeft: `4px solid ${urgent ? RED : AMBER}` }}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <strong>{c.person}</strong>
        <span>bei <Link href={`/kunden/${c.accountId}`}>{c.accountName}</Link></span>
        <Link href={`/einsaetze/${c.engagementId}#verlaengerung`} className="muted text-xs">{c.engagementTitle}</Link>
        <span className="muted text-xs ml-auto">angestoßen von {c.requestedBy}</span>
      </div>
      <p className="text-sm mt-1">
        Ende heute <strong>{c.currentEnd ? fmtDate(c.currentEnd) : "offen"}</strong>{c.daysToEnd !== null ? ` (${c.daysToEnd} Tage)` : ""} → neu <strong>{c.proposedTo ? fmtDate(c.proposedTo) : "?"}</strong> · {c.conditionsNote ?? "Konditionen unverändert"}
        {c.note ? <><br /><span className="muted">Notiz: {c.note}</span></> : null}
        {c.mocoProjectId ? <><br /><span className="muted text-xs">Bei Bestätigung wird das Projektende in Moco (Projekt {c.mocoProjectId}) gesetzt.</span></> : null}
      </p>
      <div className="flex flex-wrap items-end gap-2 mt-2 text-sm">
        <form action={decideRenewalAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="engagementId" value={c.engagementId} /><input type="hidden" name="version" value={c.version} /><input type="hidden" name="back" value={back} />
          <div>
            <label className="label" htmlFor={`rd-${c.decisionId}-f`}>Vertragsfolge</label>
            <select id={`rd-${c.decisionId}-f`} name="contractFollowUp" className="input" defaultValue="Nachtrag"><option>Nachtrag</option><option>Neue Bestellung</option><option>Rahmenabruf</option><option>Verlängerungsschreiben</option></select>
          </div>
          <div><label className="label" htmlFor={`rd-${c.decisionId}-n`}>Notiz (optional)</label><input id={`rd-${c.decisionId}-n`} name="note" className="input" style={{ minWidth: 200 }} /></div>
          <button className="btn btn-small" type="submit" name="decision" value="BESTAETIGEN" style={{ background: "#2f7d32" }}>Bestätigen</button>
          <button className="btn btn-small" type="submit" name="decision" value="ABLEHNEN" style={{ background: RED }}>Ablehnen</button>
        </form>
        {c.delegates.length > 0 && (
          <form action={decideRenewalAction} className="flex items-end gap-1">
            <input type="hidden" name="engagementId" value={c.engagementId} /><input type="hidden" name="version" value={c.version} /><input type="hidden" name="back" value={back} /><input type="hidden" name="decision" value="WEITERGEBEN" />
            <div>
              <label className="label" htmlFor={`rd-${c.decisionId}-t`}>Weitergeben an</label>
              <select id={`rd-${c.decisionId}-t`} name="targetUserId" className="input" required defaultValue="">
                <option value="" disabled>…</option>
                {c.delegates.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <button className="btn btn-secondary btn-small" type="submit">Weitergeben</button>
          </form>
        )}
      </div>
    </li>
  );
}

/** Karte „Verlängerung klären“ für Sales Operations/Betreuung: anstoßen oder Ende bestätigen lassen. */
export function RenewalStartCard({ c, back }: { c: Card; back: string }) {
  const urgent = c.daysToEnd !== null && c.daysToEnd <= 28;
  return (
    <li className="card" style={{ borderLeft: `4px solid ${urgent ? RED : "var(--border)"}` }}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <strong>{c.person}</strong>
        <span>bei <Link href={`/kunden/${c.accountId}`}>{c.accountName}</Link></span>
        <Link href={`/einsaetze/${c.engagementId}#verlaengerung`} className="muted text-xs">{c.engagementTitle}</Link>
        <span className="muted text-xs ml-auto">Ende {c.currentEnd ? fmtDate(c.currentEnd) : "offen"}{c.daysToEnd !== null ? ` · noch ${c.daysToEnd} Tage` : ""}</span>
      </div>
      <div className="mt-2"><RenewalStartForm engagementId={c.engagementId} currentEnd={c.currentEnd} back={back} compact /></div>
    </li>
  );
}

/** Block für Start und Meine Arbeit: zuerst Entscheidungen, dann Anstöße; leer → nichts. */
export function RenewalCards({ cards, back }: { cards: Card[]; back: string }) {
  const decide = cards.filter((c) => c.mode === "ENTSCHEIDEN");
  const start = cards.filter((c) => c.mode === "ANSTOSSEN");
  if (!cards.length) return null;
  return (
    <section id="entscheidungen" className="space-y-3">
      {decide.length > 0 && (
        <div>
          <h2 className="font-semibold mb-1">Entscheidungen: Verlängerungen ({decide.length})</h2>
          <ul className="space-y-2">{decide.map((c) => <RenewalDecisionCard key={c.decisionId} c={c} back={back} />)}</ul>
        </div>
      )}
      {start.length > 0 && (
        <details open={start.length <= 3 && decide.length === 0}>
          <summary className="font-semibold">Verlängerungen klären ({start.length})</summary>
          <p className="muted text-xs mt-1 mb-2">90 Tage vor Ende. Anstoßen schickt die Entscheidung an den BD; wird nicht verlängert, den Einsatz zum Ende beenden (Einsatzakte → Status).</p>
          <ul className="space-y-2">{start.map((c) => <RenewalStartCard key={c.decisionId} c={c} back={back} />)}</ul>
        </details>
      )}
    </section>
  );
}
