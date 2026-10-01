import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { DomainError } from "@/lib/errors";
import { getTeamQueue, workTargets } from "@/modules/work/service";
import { getTeam } from "@/modules/work/teams";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { WorkList } from "@/components/Work";
import { WorkCreateForm } from "@/components/WorkCreateForm";
import { reassignWorkItemAction, workItemAction } from "../../actions";

export default async function TeamPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let t, q;
  try {
    t = await getTeam(actor, id);
    q = await getTeamQueue(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const back = `/team/${id}`;
  const targets = await workTargets(actor);
  const load = new Map<string, number>();
  for (const w of q.inWork) if (w.assigneeUserId) load.set(w.assigneeUserId, (load.get(w.assigneeUserId) ?? 0) + 1);
  const late = [...q.unassigned, ...q.inWork].filter((w) => w.slaState === "VERLETZT" || w.overdue).length;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm"><Link href="/meine-arbeit?v=team">Meine Arbeit</Link></p>
        <h1 className="text-2xl font-semibold">Team-Eingang: {t.team.name}</h1>
        {t.team.description && <p className="muted text-sm">{t.team.description}</p>}
      </div>
      <Feedback params={sp} />

      <section className="card grid sm:grid-cols-4 gap-3 text-sm">
        <div><div className="muted">Noch nicht übernommen</div><div className="text-2xl font-semibold">{q.unassigned.length}</div></div>
        <div><div className="muted">In Bearbeitung</div><div className="text-2xl font-semibold">{q.inWork.length}</div></div>
        <div><div className="muted">Überfällig / SLA überschritten</div><div className="text-2xl font-semibold" style={late ? { color: "#c0392b" } : undefined}>{late}</div></div>
        <div><div className="muted">Zuletzt erledigt</div><div className="text-2xl font-semibold">{q.done.length}</div></div>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Warteschlange ({q.unassigned.length})</h2>
        {q.unassigned.length === 0 ? (
          <p className="muted text-sm">Alles übernommen.</p>
        ) : (
          <ul className="space-y-3">
            {q.unassigned.map((w) => (
              <li key={w.id}>
                <WorkList items={[w]} empty="" perspective="queue" />
                <div className="flex flex-wrap gap-2 mt-1 ml-3">
                  {t.member && (
                    <form action={workItemAction}>
                      <input type="hidden" name="workItemId" value={w.id} />
                      <input type="hidden" name="version" value={w.version} />
                      <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="action" value="ANNEHMEN" />
                      <button className="btn btn-small" type="submit">Übernehmen</button>
                    </form>
                  )}
                  {t.lead && (
                    <form action={reassignWorkItemAction} className="flex gap-2 items-center">
                      <input type="hidden" name="workItemId" value={w.id} />
                      <input type="hidden" name="version" value={w.version} />
                      <input type="hidden" name="back" value={back} />
                      <select name="target" className="input" defaultValue="" aria-label="Zuweisen an">
                        <option value="" disabled>zuweisen an …</option>
                        {t.members.map((m) => <option key={m.userId} value={m.userId}>{m.name} ({load.get(m.userId) ?? 0} in Arbeit)</option>)}
                      </select>
                      <button className="btn btn-secondary btn-small" type="submit">Zuweisen</button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">In Bearbeitung ({q.inWork.length})</h2>
        <WorkList items={q.inWork} empty="Nichts in Bearbeitung." />
      </section>

      <section className="card grid sm:grid-cols-2 gap-4">
        <div>
          <h2 className="font-semibold mb-2">Mitglieder ({t.members.length})</h2>
          <ul className="text-sm space-y-1">
            {t.members.map((m) => (
              <li key={m.userId}>{m.name}{m.role === "LEITUNG" ? " · Leitung" : ""} <span className="muted">· {load.get(m.userId) ?? 0} in Arbeit</span></li>
            ))}
          </ul>
          <p className="muted text-xs mt-2">Inhaber:innen der Rolle Sales Operations gehören automatisch dazu. Mitglieder, Leitung und Anfragearten: {t.lead ? <Link href="/verwaltung/teams">Verwaltung → Teams</Link> : "Verwaltung → Teams"}.</p>
        </div>
        <div>
          <h2 className="font-semibold mb-2">Leistungskatalog</h2>
          <ul className="text-sm space-y-1">
            {t.services.filter((s) => s.isActive).map((s) => (
              <li key={s.id}><strong>{s.name}</strong> <span className="muted">· {s.defaultWorkdays} Werktage{s.reviewRequired ? " · mit Prüfung" : ""}</span>{s.description ? <div className="muted text-xs">{s.description}</div> : null}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="card">
        <details>
          <summary className="font-semibold">Anfrage an {t.team.name} stellen</summary>
          <WorkCreateForm users={targets.users} teams={targets.teams.filter((x) => x.id === id)} back={back} idPrefix="team" defaultTarget={`team:${id}`} />
        </details>
      </section>
    </div>
  );
}
