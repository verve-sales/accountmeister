import Link from "next/link";
import { createInitiativeAction, setInitiativeStatusAction, updateProcurementAction } from "@/app/actions";
import { initiativeKindLabel, initiativeKindValues, procurementLabel, type InitiativeKind } from "@/modules/agenda/service";
import { fmtDate, opportunityStatusLabel } from "@/lib/labels";

type Initiative = {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  dueHint: string | null;
  status: string;
  version: number;
  chances: { id: string; title: string; status: string }[];
};

const HEADINGS: Record<InitiativeKind, string> = { PRIORITAET: "Prioritäten des Kunden", INITIATIVE: "Schlüssel-Initiativen", HERAUSFORDERUNG: "Herausforderungen & Problembereiche" };

/** Kundenagenda (Etappe 26): was den Kunden treibt – getrennt von unseren Chancen, aber mit ihnen verknüpft. */
export function KundenAgenda({ accountId, initiatives, canEdit, back }: { accountId: string; initiatives: Initiative[]; canEdit: boolean; back: string }) {
  const open = initiatives.filter((i) => i.status === "OFFEN");
  const done = initiatives.filter((i) => i.status !== "OFFEN");
  return (
    <section className="card" id="agenda">
      <h2 className="font-semibold mb-1">Kundenagenda – was treibt den Kunden?</h2>
      <p className="muted text-sm mb-3">Prioritäten, Schlüssel-Initiativen und Herausforderungen des Kunden in seinen Worten. Chancen zeigen, auf welche Initiative sie einzahlen. Initiativen mit Datum erinnern {`120`} Tage vorher.</p>
      {open.length === 0 && <p className="muted text-sm">Noch nichts erfasst. Tipp: eine bestehende Account-Seite (z. B. aus Notion) in den Assistenten einfügen – er schlägt die Einträge als Karten vor.</p>}
      <div className="grid md:grid-cols-3 gap-4">
        {initiativeKindValues.map((k) => {
          const list = open.filter((i) => i.kind === k);
          if (!list.length) return null;
          return (
            <div key={k}>
              <h3 className="text-sm font-semibold mb-1">{HEADINGS[k]}</h3>
              <ul className="space-y-2 text-sm">
                {list.map((i) => (
                  <li key={i.id} style={{ borderLeft: "3px solid var(--border)", paddingLeft: ".5rem" }}>
                    <div className="font-medium">{i.title}</div>
                    {i.description && <div className="muted text-xs" style={{ whiteSpace: "pre-wrap" }}>{i.description}</div>}
                    {(i.dueDate || i.dueHint) && <div className="text-xs">Termin: {i.dueDate ? fmtDate(i.dueDate) : ""}{i.dueHint && (!i.dueDate || i.dueHint !== i.dueDate) ? `${i.dueDate ? " · " : ""}„${i.dueHint}“` : ""}</div>}
                    {i.chances.length > 0 && (
                      <div className="text-xs mt-1">
                        Zahlt ein: {i.chances.map((c, n) => <span key={c.id}>{n ? " · " : ""}<Link href={`/bedarfe/${c.id}`}>{c.title}</Link> ({opportunityStatusLabel[c.status] ?? c.status})</span>)}
                      </div>
                    )}
                    {canEdit && (
                      <form action={setInitiativeStatusAction} className="flex gap-1 mt-1">
                        <input type="hidden" name="initiativeId" value={i.id} />
                        <input type="hidden" name="version" value={i.version} />
                        <input type="hidden" name="back" value={back} />
                        <button className="btn btn-secondary btn-small" name="status" value="ERLEDIGT" type="submit">Erledigt</button>
                        <button className="btn btn-secondary btn-small" name="status" value="VERWORFEN" type="submit">Verwerfen</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      {done.length > 0 && (
        <details className="mt-3 text-sm">
          <summary>Erledigt oder verworfen ({done.length})</summary>
          <ul className="mt-1">
            {done.map((i) => <li key={i.id} className="muted">{initiativeKindLabel[i.kind as InitiativeKind] ?? i.kind}: {i.title} ({i.status === "ERLEDIGT" ? "erledigt" : "verworfen"})</li>)}
          </ul>
        </details>
      )}
      {canEdit && (
        <details className="mt-3">
          <summary>Eintrag hinzufügen</summary>
          <form action={createInitiativeAction} className="grid sm:grid-cols-2 gap-3 mt-2">
            <input type="hidden" name="accountId" value={accountId} />
            <input type="hidden" name="back" value={back} />
            <div>
              <label className="label" htmlFor="iniKind">Art</label>
              <select id="iniKind" name="kind" className="select" defaultValue="INITIATIVE">
                {initiativeKindValues.map((k) => <option key={k} value={k}>{initiativeKindLabel[k]}</option>)}
              </select>
            </div>
            <div><label className="label" htmlFor="iniTitle">Bezeichnung</label><input id="iniTitle" name="title" className="input" required minLength={3} placeholder="z. B. Toolvertrag läuft Ende 2026 aus" /></div>
            <div className="sm:col-span-2"><label className="label" htmlFor="iniDesc">Beschreibung (optional)</label><textarea id="iniDesc" name="description" className="textarea" rows={2} /></div>
            <div><label className="label" htmlFor="iniDue">Datum (optional)</label><input id="iniDue" name="dueDate" type="date" className="input" /></div>
            <div><label className="label" htmlFor="iniHint">oder ungefähr (z. B. „Ende 2026“, „Q2 2027“)</label><input id="iniHint" name="dueHint" className="input" /></div>
            <div className="sm:col-span-2"><button className="btn" type="submit">Aufnehmen</button></div>
          </form>
        </details>
      )}
    </section>
  );
}

/** Beschaffungsweg: direkt, über Vermittler oder Rahmenvertrag. */
export function Beschaffung({ account, canEdit, back }: { account: { id: string; version: number; procurementChannel: string | null; intermediaryName: string | null; procurementNote: string | null }; canEdit: boolean; back: string }) {
  return (
    <section className="card">
      <h2 className="font-semibold mb-1">Einkauf & Beschaffung</h2>
      <p className="text-sm">
        {account.procurementChannel ? <>Wir arbeiten {procurementLabel[account.procurementChannel] ?? account.procurementChannel}{account.intermediaryName ? <>: <strong>{account.intermediaryName}</strong></> : null}.</> : <span className="muted">Beschaffungsweg noch nicht erfasst – direkt, über Vermittler oder Rahmenvertrag?</span>}
        {account.procurementNote && <span className="muted"> {account.procurementNote}</span>}
      </p>
      {canEdit && (
        <details className="mt-2">
          <summary className="text-sm">Beschaffungsweg bearbeiten</summary>
          <form action={updateProcurementAction} className="grid sm:grid-cols-3 gap-3 mt-2">
            <input type="hidden" name="accountId" value={account.id} />
            <input type="hidden" name="version" value={account.version} />
            <input type="hidden" name="back" value={back} />
            <div>
              <label className="label" htmlFor="pcCh">Weg</label>
              <select id="pcCh" name="procurementChannel" className="select" defaultValue={account.procurementChannel ?? ""}>
                <option value="">unbekannt</option>
                <option value="DIREKT">direkt beim Kunden</option>
                <option value="VERMITTLER">über Vermittler</option>
                <option value="RAHMENVERTRAG">über Rahmenvertrag</option>
              </select>
            </div>
            <div><label className="label" htmlFor="pcName">Vermittler / Rahmenvertrag</label><input id="pcName" name="intermediaryName" className="input" defaultValue={account.intermediaryName ?? ""} /></div>
            <div><label className="label" htmlFor="pcNote">Notiz</label><input id="pcNote" name="procurementNote" className="input" defaultValue={account.procurementNote ?? ""} /></div>
            <div className="sm:col-span-3"><button className="btn btn-secondary" type="submit">Speichern</button></div>
          </form>
        </details>
      )}
    </section>
  );
}
