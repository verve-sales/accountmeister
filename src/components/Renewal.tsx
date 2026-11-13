import Link from "next/link";
import { fmtDate } from "@/lib/labels";
import { plusDaysIso } from "@/modules/work/calendar";
import type { RenewalCard as Card } from "@/modules/engagements/care";
import { approachLabel } from "@/modules/engagements/contacts";
import { decideRenewalAction, startRenewalAction } from "@/app/actions";

const RED = "#c0392b";
const AMBER = "#b7791f";


/** Über wen läuft die Verlängerung (e37) – eine Zeile auf der Karte. */
function RenewalContactLine({ c }: { c: Card }) {
  const k = c.contacts;
  return (
    <p className="text-xs mt-1">
      <span className="muted">Verlängerung über </span>
      {k.renewal ? <><strong>{k.renewal.name}</strong>{k.renewal.role ? <span className="muted"> ({k.renewal.role})</span> : null}{k.renewal.email ? <> · <a href={`mailto:${k.renewal.email}`}>{k.renewal.email}</a></> : null}{k.renewal.phone ? <> · {k.renewal.phone}</> : null}</> : <Link href={`/einsaetze/${c.engagementId}#ansprechpartner`} style={{ color: "#b7791f" }}>Ansprechpartner hinterlegen</Link>}
      {k.order && k.order.id !== k.renewal?.id ? <><span className="muted"> · Bestellung über </span>{k.order.name}</> : null}
      {k.approach ? <><span className="muted"> · spricht an: </span>{approachLabel[k.approach]}</> : null}
    </p>
  );
}

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** „Verlängerung anstoßen“ – ein Datum, Konditionen unverändert als Vorgabe, optional Notiz (Use Case 1, Schritt 2). */
export function RenewalStartForm({ engagementId, currentEnd, back, compact = false, lastRates, canDecide = false, offers, offerPreselect }: { engagementId: string; currentEnd: string | null; back: string; compact?: boolean; lastRates?: { ek: string | null; vk: string | null; unit: string } | null; /** darf selbst bestätigen: ein Schritt statt zwei */ canDecide?: boolean; /** e48e: Angebote des Kunden aus SharePoint (passende zuerst) */ offers?: { value: string; name: string }[] | null; offerPreselect?: string | null }) {
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
      <div>
        <label className="label" htmlFor={`${idp}-po`}>Neue Bestellnummer (falls schon da)</label>
        <input id={`${idp}-po`} name="orderReference" className="input" maxLength={200} />
      </div>
      {offers && (
        <>
          <div className={compact ? "" : "sm:col-span-2"}>
            <label className="label" htmlFor={`${idp}-offer`}>Angebot (aus SharePoint, optional)</label>
            <select id={`${idp}-offer`} name="offerPick" className="select" defaultValue={offerPreselect ?? ""} style={{ maxWidth: "100%" }}>
              <option value="">– kein Angebot –</option>
              {offers.map((o) => <option key={o.value} value={o.value}>{o.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={`${idp}-offno`}>Angebotsnummer</label>
            <input id={`${idp}-offno`} name="offerNumber" className="input" maxLength={100} placeholder="leer = aus dem Dateinamen" />
          </div>
        </>
      )}
      <div className={compact ? "" : "sm:col-span-2"}>
        <label className="label" htmlFor={`${idp}-note`}>Notiz (optional)</label>
        <input id={`${idp}-note`} name="note" className="input" placeholder="z. B. Kunde hat mündlich zugesagt, Bestellung folgt" style={{ minWidth: compact ? 200 : undefined }} />
      </div>
      <div className="flex flex-wrap gap-2">
        {canDecide && <button className="btn btn-small" type="submit" name="direct" value="1" style={{ background: "#2f7d32" }}>Verlängern</button>}
        <button className={canDecide ? "btn btn-secondary btn-small" : "btn btn-small"} type="submit">{canDecide ? "Erst zur Bestätigung geben" : "Verlängerung anstoßen"}</button>
      </div>
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
      <RenewalContactLine c={c} />
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
          <div><label className="label" htmlFor={`rd-${c.decisionId}-po`}>Neue Bestellnummer</label><input id={`rd-${c.decisionId}-po`} name="orderReference" className="input" defaultValue={c.orderReference ?? ""} placeholder="falls schon da" maxLength={200} style={{ width: 150 }} /></div>
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
      <RenewalContactLine c={c} />
      <div className="mt-2"><RenewalStartForm engagementId={c.engagementId} currentEnd={c.currentEnd} back={back} compact canDecide={c.canDecide} /></div>
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
          <p className="muted text-xs mt-1 mb-2">Wird nicht verlängert: den Einsatz zum Ende beenden (am Einsatz unter Status).</p>
          <ul className="space-y-2">{start.map((c) => <RenewalStartCard key={c.decisionId} c={c} back={back} />)}</ul>
        </details>
      )}
    </section>
  );
}
