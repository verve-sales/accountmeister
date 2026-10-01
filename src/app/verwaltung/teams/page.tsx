import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { canManageTeams, getTeam, listTeams } from "@/modules/work/teams";
import { workTargets } from "@/modules/work/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { createTeamAction, saveServiceTypeAction, setTeamMemberAction } from "../../actions";

const fieldsToText = (fields: { label: string; required: boolean }[]) => fields.map((f) => `${f.label}${f.required ? "*" : ""}`).join("\n");

export default async function TeamsVerwaltungPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!canManageTeams(actor)) redirect("/start?fehler=" + encodeURIComponent("Teams pflegen Betriebsverwaltung, Principals und CEO."));
  const teams = await listTeams(actor);
  const details = await Promise.all(teams.map((t) => getTeam(actor, t.id)));
  const targets = await workTargets(actor);
  const users = [{ id: actor.userId, name: `${actor.displayName} (ich)` }, ...targets.users];
  const back = "/verwaltung/teams";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Teams und Leistungskatalog</h1>
        <p className="muted text-sm">Teams haben einen eigenen Eingang. Anfragearten legen Pflichtangaben, Standardfrist (Werktage, NRW-Feiertage ausgenommen), Checkliste und Prüfung fest.</p>
      </div>
      <Feedback params={sp} />

      {details.map((d) => (
        <section key={d.team.id} className="card space-y-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="font-semibold text-lg">{d.team.name}</h2>
            <Link href={`/team/${d.team.id}`} className="text-sm">Zum Eingang</Link>
            {d.team.implicitRole && <span className="muted text-xs">Inhaber:innen der Rolle {d.team.implicitRole === "SALES_OPS" ? "Sales Operations" : d.team.implicitRole} sind automatisch Mitglied.</span>}
          </div>

          <div>
            <h3 className="font-semibold text-sm mb-1">Mitglieder</h3>
            <ul className="text-sm space-y-1">
              {d.members.map((m) => (
                <li key={m.userId} className="flex flex-wrap gap-2 items-center">
                  {m.name} · {m.role === "LEITUNG" ? "Leitung" : "Mitglied"}{m.implicit ? " (über Rolle)" : ""}
                  {!m.implicit && (
                    <form action={setTeamMemberAction}>
                      <input type="hidden" name="teamId" value={d.team.id} />
                      <input type="hidden" name="userId" value={m.userId} />
                      <input type="hidden" name="remove" value="1" />
                      <input type="hidden" name="back" value={back} />
                      <button className="btn btn-secondary btn-small" type="submit">Entfernen</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
            <form action={setTeamMemberAction} className="flex flex-wrap gap-2 items-end mt-2">
              <input type="hidden" name="teamId" value={d.team.id} />
              <input type="hidden" name="back" value={back} />
              <div>
                <label className="label" htmlFor={`mu-${d.team.id}`}>Person</label>
                <select id={`mu-${d.team.id}`} name="userId" className="input" defaultValue="">
                  <option value="" disabled>bitte wählen</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor={`mr-${d.team.id}`}>Rolle im Team</label>
                <select id={`mr-${d.team.id}`} name="role" className="input" defaultValue="MITGLIED">
                  <option value="MITGLIED">Mitglied</option>
                  <option value="LEITUNG">Leitung (verteilt Vorgänge)</option>
                </select>
              </div>
              <button className="btn btn-secondary btn-small" type="submit">Hinzufügen / ändern</button>
            </form>
          </div>

          <div>
            <h3 className="font-semibold text-sm mb-1">Anfragearten</h3>
            <div className="space-y-2">
              {[...d.services, null].map((s) => (
                <details key={s?.id ?? "neu"} className="border rounded-md p-2" style={{ borderColor: "var(--border)" }}>
                  <summary className="text-sm">{s ? <><strong>{s.name}</strong> <span className="muted">· {s.defaultWorkdays} Werktage{s.reviewRequired ? " · mit Prüfung" : ""}{s.isActive ? "" : " · inaktiv"}</span></> : "Neue Anfrageart"}</summary>
                  <form action={saveServiceTypeAction} className="grid sm:grid-cols-2 gap-3 mt-2">
                    <input type="hidden" name="teamId" value={d.team.id} />
                    <input type="hidden" name="back" value={back} />
                    {s && <input type="hidden" name="serviceTypeId" value={s.id} />}
                    <div><label className="label" htmlFor={`sn-${s?.id ?? d.team.id}`}>Name</label><input id={`sn-${s?.id ?? d.team.id}`} name="name" className="input" defaultValue={s?.name ?? ""} required /></div>
                    <div><label className="label" htmlFor={`sd-${s?.id ?? d.team.id}`}>Standardfrist (Werktage)</label><input id={`sd-${s?.id ?? d.team.id}`} type="number" min={0} max={60} name="defaultWorkdays" className="input" defaultValue={s?.defaultWorkdays ?? 3} /></div>
                    <div className="sm:col-span-2"><label className="label" htmlFor={`sx-${s?.id ?? d.team.id}`}>Beschreibung</label><input id={`sx-${s?.id ?? d.team.id}`} name="description" className="input" defaultValue={s?.description ?? ""} /></div>
                    <div><label className="label" htmlFor={`sf-${s?.id ?? d.team.id}`}>Angaben (je Zeile, Pflicht mit *)</label><textarea id={`sf-${s?.id ?? d.team.id}`} name="fieldsText" className="input" rows={4} defaultValue={s ? fieldsToText(s.fields as { label: string; required: boolean }[]) : ""} /></div>
                    <div><label className="label" htmlFor={`sc-${s?.id ?? d.team.id}`}>Checkliste (je Zeile ein Punkt)</label><textarea id={`sc-${s?.id ?? d.team.id}`} name="checklistText" className="input" rows={4} defaultValue={s ? (s.checklist as string[]).join("\n") : ""} /></div>
                    <label className="text-sm flex items-center gap-2"><input type="checkbox" name="reviewRequired" defaultChecked={s?.reviewRequired ?? true} /> Ergebnis vor Abschluss von der Auftraggeber:in prüfen</label>
                    <input type="hidden" name="isActive" value="false" />
                    <label className="text-sm flex items-center gap-2"><input type="checkbox" name="isActive" defaultChecked={s?.isActive ?? true} value="on" /> aktiv</label>
                    <div className="sm:col-span-2"><button className="btn btn-small" type="submit">Speichern</button></div>
                  </form>
                </details>
              ))}
            </div>
          </div>
        </section>
      ))}

      <section className="card">
        <h2 className="font-semibold mb-2">Neues Team</h2>
        <form action={createTeamAction} className="flex flex-wrap gap-2 items-end">
          <input type="hidden" name="back" value={back} />
          <div><label className="label" htmlFor="tn">Name</label><input id="tn" name="name" className="input" required /></div>
          <div className="grow"><label className="label" htmlFor="td">Beschreibung</label><input id="td" name="description" className="input" /></div>
          <button className="btn btn-small" type="submit">Anlegen</button>
        </form>
      </section>
    </div>
  );
}
