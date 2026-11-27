import Link from "next/link";
import { cleanupMergeEngagementsAction, cleanupMergeSetupsAction } from "@/app/actions";
import { PendingButton } from "@/components/PendingButton";
import { fmtDate } from "@/lib/labels";
import { engagementStatusLabel } from "@/modules/engagements/service";
import type { EngagementDuplicate, SetupDuplicate } from "@/modules/cleanup/service";

/** Doppelte Einsätze zusammenführen (Bereinigung und Kundenseite). */
export function EngagementMergeForm({ g, back, showAccount = true }: { g: EngagementDuplicate; back?: string; showAccount?: boolean }) {
  return (
    <form action={cleanupMergeEngagementsAction} className="space-y-1" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      {back && <input type="hidden" name="back" value={back} />}
      <div className="text-sm"><strong>{g.personName}</strong>{showAccount ? ` · ${g.accountName}` : ""} <span className="muted text-xs">– {g.reason}</span></div>
      {[g.keep, ...g.drop].map((e, i) => (
        <label key={e.id} className="flex gap-2 items-baseline text-sm">
          <input type="hidden" name="ids" value={e.id} />
          <input type="radio" name="keep" value={e.id} defaultChecked={i === 0} />
          <span><Link href={`/einsaetze/${e.id}`}>{e.title}</Link> <span className="muted text-xs">{engagementStatusLabel[e.status] ?? e.status} · {e.start ? fmtDate(e.start) : "?"} – {e.end ? fmtDate(e.end) : "offen"}{e.moco ? ` · Moco ${e.moco}` : " · ohne Moco"}{i === 0 ? " · empfohlen (mehr Verlauf)" : ""}</span></span>
        </label>
      ))}
      <PendingButton busy="Führe zusammen …" className="btn btn-small">Zusammenführen (gewählten behalten)</PendingButton>
    </form>
  );
}

/** Doppelte bzw. Platzhalter-Projekte zusammenführen. */
export function SetupMergeForm({ g, back, showAccount = true }: { g: SetupDuplicate; back?: string; showAccount?: boolean }) {
  return (
    <form action={cleanupMergeSetupsAction} className="space-y-1" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      {back && <input type="hidden" name="back" value={back} />}
      {showAccount && <div className="text-sm"><Link href={`/kunden/${g.accountId}`}>{g.accountName}</Link></div>}
      {[g.keep, ...g.drop].map((s, i) => (
        <label key={s.id} className="flex gap-2 items-baseline text-sm">
          <input type="hidden" name="ids" value={s.id} />
          <input type="radio" name="keep" value={s.id} defaultChecked={i === 0} />
          <span><Link href={`/setups/${s.id}`}>{s.name}</Link> <span className="muted text-xs">Umfang {s.score}{i === 0 ? " · empfohlen" : ""}</span></span>
        </label>
      ))}
      <PendingButton busy="Führe zusammen …" className="btn btn-small">Zusammenführen (gewähltes behalten)</PendingButton>
    </form>
  );
}

/** Projekt-Seite: dieses Projekt in einem anderen Projekt desselben Kunden aufgehen lassen. */
export function SetupMergeInto({ setupId, setupName, others, back }: { setupId: string; setupName: string; others: { id: string; name: string }[]; back: string }) {
  if (!others.length) return null;
  return (
    <section className="card">
      <details>
        <summary className="text-sm muted">In ein anderes Projekt dieses Kunden überführen …</summary>
        <form action={cleanupMergeSetupsAction} className="mt-2 flex flex-wrap gap-2 items-end text-sm">
          <input type="hidden" name="back" value={back} />
          <input type="hidden" name="ids" value={setupId} />
          <p className="w-full">Alles aus „{setupName}“ – Chancen, Positionen, Einsätze, Beobachtungen, Aktionen, Quellen, Beteiligte – zieht in das gewählte Projekt; „{setupName}“ verschwindet danach. Nichts geht verloren.</p>
          <div><label className="label" htmlFor={`mi-${setupId}`}>Ziel-Projekt</label><select id={`mi-${setupId}`} name="keep" className="select" required defaultValue="">
            <option value="" disabled>Bitte wählen …</option>
            {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select></div>
          <PendingButton busy="Überführe …" className="btn btn-small">Überführen</PendingButton>
        </form>
      </details>
    </section>
  );
}
