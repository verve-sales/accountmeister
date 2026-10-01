import Link from "next/link";
import type { Actor } from "@/modules/identity/actor";
import { canManageStaffingAt, freelancerOptions, positionStatusLabel, scopeUnitLabel, staffingSummary, type PositionView } from "@/modules/staffing/service";
import { createPositionAction, createStaffingIntakeAction } from "@/app/actions";
import { QuickFillForm } from "./QuickFillForm";
import { fmtDate } from "@/lib/labels";

const RED = "#c0392b";

type Row = Pick<PositionView, "id" | "title" | "status" | "progress" | "bdName" | "nextDue" | "overdue" | "accountName" | "opportunityTitle"> & Partial<Pick<PositionView, "searcherName" | "candidacyCount" | "presentedCount" | "searchStatus">>;

export function PositionList({ items, empty, showAccount = true }: { items: Row[]; empty: string; showAccount?: boolean }) {
  if (!items.length) return <p className="muted text-sm">{empty}</p>;
  return (
    <ul className="space-y-2">
      {items.map((p) => (
        <li key={p.id} className="text-sm" style={{ borderLeft: `3px solid ${p.overdue ? RED : p.status === "BESETZT" ? "#2f7d32" : "var(--border)"}`, paddingLeft: ".6rem" }}>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Link href={`/besetzung/${p.id}`}>
              <strong>{p.title}</strong>
            </Link>
            <span className="status">{positionStatusLabel[p.status] ?? p.status}</span>
            <span className="muted text-xs">{p.progress}</span>
          </div>
          <div className="muted text-xs">
            {showAccount ? `${p.accountName} · ${p.opportunityTitle} · ` : ""}BD {p.bdName}
            {p.searcherName ? ` · Suche: ${p.searcherName}` : p.searchStatus === "ANGEFRAGT" ? " · Suche: wartet auf Übernahme" : ""}
            {typeof p.candidacyCount === "number" ? ` · ${p.candidacyCount} Kandidatur(en), ${p.presentedCount ?? 0} vorgestellt` : ""}
            {p.nextDue ? <span style={p.overdue ? { color: RED, fontWeight: 600 } : undefined}> · nächste Frist {fmtDate(p.nextDue)}{p.overdue ? " (überfällig)" : ""}</span> : ""}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Formular für eine neue Position (Entwurf). */
export function PositionForm({ opportunityId, back, users, defaultBdId, roles }: { opportunityId: string; back: string; users: { id: string; name: string }[]; defaultBdId: string | null; roles: { id: string; name: string }[] }) {
  return (
    <form action={createPositionAction} className="grid sm:grid-cols-2 gap-3 mt-2">
      <input type="hidden" name="opportunityId" value={opportunityId} />
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="open" value="1" />
      <div className="sm:col-span-2">
        <label className="label" htmlFor="pf-title">Titel / Rolle</label>
        <input id="pf-title" name="title" className="input" required minLength={3} maxLength={200} placeholder="z. B. Senior Java-Entwickler:in" />
      </div>
      <fieldset className="sm:col-span-2 flex flex-wrap gap-4 items-center">
        <legend className="label">Ressourcenart</legend>
        <label className="text-sm flex items-center gap-1"><input type="radio" name="resourceKind" value="FREELANCER" defaultChecked /> Freelancer (Suche, Kandidaturen, EK/VK)</label>
        <label className="text-sm flex items-center gap-1"><input type="radio" name="resourceKind" value="INTERN" /> intern (keine Einkaufskonditionen)</label>
      </fieldset>
      <div>
        <label className="label" htmlFor="pf-role">Standardrolle (optional)</label>
        <select id="pf-role" name="roleId" className="input" defaultValue="">
          <option value="">–</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="pf-bd">Verantwortlicher BD</label>
        <select id="pf-bd" name="bdUserId" className="input" defaultValue={defaultBdId ?? ""}>
          <option value="">(Chance/Setup-BD)</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="pf-must">Muss-Anforderungen (Pflicht für „offen“)</label>
        <textarea id="pf-must" name="mustHave" className="input" rows={3} maxLength={4000} placeholder="je Zeile eine Anforderung" />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="pf-tasks">Aufgaben</label>
        <textarea id="pf-tasks" name="tasks" className="input" rows={3} maxLength={4000} />
      </div>
      <div><label className="label" htmlFor="pf-nice">Kann-Anforderungen</label><textarea id="pf-nice" name="niceToHave" className="input" rows={2} maxLength={4000} /></div>
      <div><label className="label" htmlFor="pf-loc">Einsatzort / Remote</label><input id="pf-loc" name="location" className="input" maxLength={200} placeholder="z. B. Köln, 60 % remote" /></div>
      <div><label className="label" htmlFor="pf-lang">Sprache</label><input id="pf-lang" name="language" className="input" maxLength={100} /></div>
      <div className="grid grid-cols-2 gap-2">
        <div><label className="label" htmlFor="pf-start">Gewünschter Start</label><input id="pf-start" type="date" name="desiredStart" className="input" /></div>
        <div><label className="label" htmlFor="pf-end">Geplantes Ende</label><input id="pf-end" type="date" name="plannedEnd" className="input" /></div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div><label className="label" htmlFor="pf-scope">Umfang</label><input id="pf-scope" type="number" min={0} max={1000} name="scopeAmount" className="input" /></div>
        <div>
          <label className="label" htmlFor="pf-unit">Einheit</label>
          <select id="pf-unit" name="scopeUnit" className="input" defaultValue="TAGE_PRO_WOCHE">
            {Object.entries(scopeUnitLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>
      <div><label className="label" htmlFor="pf-due">Zieltermin für Vorschläge</label><input id="pf-due" type="date" name="proposalDue" className="input" /></div>
      <label className="text-sm flex items-center gap-2 self-end"><input type="checkbox" name="endOpen" value="on" /> Ende offen</label>
      <fieldset className="sm:col-span-2 grid sm:grid-cols-5 gap-2 border rounded-md p-2" style={{ borderColor: "var(--border)" }}>
        <legend className="label">Interne Konditionen (nur BD, Principal, Suchbearbeiter:in)</legend>
        <div><label className="label" htmlFor="pf-ekmin">EK von</label><input id="pf-ekmin" name="ekMin" className="input" inputMode="decimal" placeholder="€" /></div>
        <div><label className="label" htmlFor="pf-ekmax">EK bis</label><input id="pf-ekmax" name="ekMax" className="input" inputMode="decimal" placeholder="€" /></div>
        <div><label className="label" htmlFor="pf-vkmin">Angebot von</label><input id="pf-vkmin" name="vkMin" className="input" inputMode="decimal" placeholder="€" /></div>
        <div><label className="label" htmlFor="pf-vkmax">Angebot bis</label><input id="pf-vkmax" name="vkMax" className="input" inputMode="decimal" placeholder="€" /></div>
        <div>
          <label className="label" htmlFor="pf-rate">je</label>
          <select id="pf-rate" name="rateUnit" className="input" defaultValue="TAG"><option value="TAG">Tag</option><option value="STUNDE">Stunde</option></select>
        </div>
        <p className="muted text-xs sm:col-span-5">Unbekannt leer lassen – nicht 0. Keine pauschale Tageslänge. Bei „intern“ werden EK-Angaben ignoriert.</p>
      </fieldset>
      <div className="sm:col-span-2"><label className="label" htmlFor="pf-notes">Interne Hinweise</label><textarea id="pf-notes" name="internalNotes" className="input" rows={2} maxLength={4000} /></div>
      <div className="sm:col-span-2"><button className="btn btn-small" type="submit">Position anlegen (Entwurf)</button></div>
    </form>
  );
}

/** Block „Besetzung“ auf der Chance-Seite. */
export async function StaffingBlock({ actor, opportunityId, back, users, defaultBdId, roles, closed }: { actor: Actor; opportunityId: string; back: string; users: { id: string; name: string }[]; defaultBdId: string | null; roles: { id: string; name: string }[]; closed: boolean }) {
  const manage = await canManageStaffingAt(actor, opportunityId);
  const sum = await staffingSummary(actor, opportunityId);
  if (!manage && sum.total === 0) return null;
  const freelancers = manage ? await freelancerOptions(actor) : [];
  return (
    <section className="card" id="besetzung">
      <div className="flex flex-wrap items-baseline gap-2 mb-2">
        <h2 className="font-semibold">Besetzung{sum.total ? ` (${sum.filled}/${sum.total} besetzt)` : ""}</h2>
        <span className="muted text-xs">Je Platz eine Position. Steht die Person fest: Schnellbesetzung. Sonst Bedarf erfassen, Suche an Sales Operations geben, Kandidaten prüfen, vorstellen, auswählen.</span>
        <Link href="/besetzung" className="text-xs ml-auto">Alle Besetzungen</Link>
      </div>
      <PositionList items={sum.items} empty="Noch keine Position an dieser Chance." showAccount={false} />
      {sum.filled > 0 && sum.open > 0 && <p className="text-xs muted mt-2">Teilbesetzung: {sum.filled} Platz/Plätze besetzt, {sum.open} weiter offen. Die Chance wird dadurch nicht automatisch „beauftragt“ – der Abschluss läuft wie bisher über <a href="#auftrag">Angebot und Auftrag</a>.</p>}
      {sum.filled > 0 && sum.open === 0 && <p className="text-xs mt-2">Alle Positionen besetzt. Weiter im bestehenden Abschluss: <a href="#auftrag">Auftrag anlegen bzw. Beauftragung bestätigen</a>.</p>}
      {manage && !closed && (
        <>
          <details className="mt-3" open={sum.total === 0}>
            <summary><strong>Schnellbesetzung</strong> – Person steht fest (intern oder Freelancer), kein Suchauftrag nötig</summary>
            <QuickFillForm opportunityId={opportunityId} back={back} users={users} freelancers={freelancers} />
          </details>
          <details className="mt-2">
            <summary>Position mit Suche anlegen (Bedarf erfassen, Sales Operations sucht)</summary>
            <PositionForm opportunityId={opportunityId} back={back} users={users} defaultBdId={defaultBdId} roles={roles} />
          </details>
          <details className="mt-2">
            <summary>Aus Text übernehmen (E-Mail oder Notiz einfügen)</summary>
            <form action={createStaffingIntakeAction} className="mt-2 space-y-2">
              <input type="hidden" name="opportunityId" value={opportunityId} />
              <input type="hidden" name="back" value={back} />
              <textarea name="text" className="input" rows={6} required minLength={20} maxLength={40000} placeholder="Text einfügen – es entstehen Vorschläge mit Belegstellen, die du vor der Übernahme prüfst. Der Text bleibt als Quelle am Setup." />
              <button className="btn btn-secondary btn-small" type="submit">Vorschläge erzeugen</button>
            </form>
          </details>
        </>
      )}
    </section>
  );
}
