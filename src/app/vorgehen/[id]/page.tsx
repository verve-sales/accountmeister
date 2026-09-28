import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { canManagePlaybooks, listPlaybooks } from "@/modules/playbooks/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { playbookScopeLabel } from "@/lib/labels";
import { addPlaybookStepAction, movePlaybookStepAction, removePlaybookStepAction, updatePlaybookAction, updatePlaybookStepAction } from "../../actions";

type StepDefaults = { title?: string; goal?: string | null; meddpicc?: string | null; suggestedAction?: string | null; doneCriterion?: string | null; dueInDays?: number | null };

function StepFields({ prefix, s }: { prefix: string; s: StepDefaults }) {
  return (
    <>
      <div className="sm:col-span-2"><label className="label" htmlFor={`${prefix}-title`}>Schritt</label><input id={`${prefix}-title`} name="title" className="input" required minLength={3} maxLength={160} defaultValue={s.title ?? ""} /></div>
      <div className="sm:col-span-2"><label className="label" htmlFor={`${prefix}-goal`}>Wozu dient der Schritt?</label><input id={`${prefix}-goal`} name="goal" className="input" maxLength={1000} defaultValue={s.goal ?? ""} /></div>
      <div><label className="label" htmlFor={`${prefix}-med`}>MEDDPICC-Bezug</label><input id={`${prefix}-med`} name="meddpicc" className="input" maxLength={200} defaultValue={s.meddpicc ?? ""} placeholder="z. B. Metrics, Champion" /></div>
      <div><label className="label" htmlFor={`${prefix}-due`}>Richtwert (Tage ab Aktivierung)</label><input id={`${prefix}-due`} name="dueInDays" type="number" min={0} max={365} className="input" defaultValue={s.dueInDays ?? ""} /></div>
      <div className="sm:col-span-2"><label className="label" htmlFor={`${prefix}-act`}>Vorschlag: was konkret tun?</label><textarea id={`${prefix}-act`} name="suggestedAction" className="textarea" rows={2} maxLength={2000} defaultValue={s.suggestedAction ?? ""} /></div>
      <div className="sm:col-span-2"><label className="label" htmlFor={`${prefix}-done`}>Erledigt, wenn …</label><input id={`${prefix}-done`} name="doneCriterion" className="input" maxLength={1000} defaultValue={s.doneCriterion ?? ""} /></div>
    </>
  );
}

export default async function VorgehenBearbeitenPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!canManagePlaybooks(actor)) redirect("/vorgehen");
  const p = (await listPlaybooks(actor)).find((x) => x.id === id);
  if (!p) notFound();

  return (
    <div className="space-y-6">
      <p className="text-sm"><Link href="/vorgehen">Vorgehensmuster</Link> › {p.name}</p>
      <h1 className="text-2xl font-semibold">{p.name} bearbeiten</h1>
      <p className="muted text-sm">Wird angewendet auf: {playbookScopeLabel[p.scope]}. Änderungen gelten für neu gestartete Vorgehen; laufende Vorgehen behalten ihre Schritte.</p>
      <Feedback params={sp} />

      <section className="card">
        <form action={updatePlaybookAction} className="grid sm:grid-cols-2 gap-3">
          <input type="hidden" name="playbookId" value={p.id} />
          <input type="hidden" name="version" value={p.version} />
          <div><label className="label" htmlFor="pName">Name</label><input id="pName" name="name" className="input" required minLength={3} maxLength={120} defaultValue={p.name} /></div>
          <label className="flex items-center gap-2 text-sm self-end"><input type="checkbox" name="active" value="on" defaultChecked={p.active} /> aktiv (kann gestartet werden)</label>
          <div className="sm:col-span-2"><label className="label" htmlFor="pDesc">Beschreibung</label><textarea id="pDesc" name="description" className="textarea" rows={2} maxLength={1000} defaultValue={p.description ?? ""} /></div>
          <div className="sm:col-span-2"><button className="btn" type="submit">Speichern</button></div>
        </form>
      </section>

      {p.steps.map((s, i) => (
        <section key={s.id} className="card">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h2 className="font-semibold">Schritt {s.position}</h2>
            <div className="ml-auto flex gap-2">
              {i > 0 && (
                <form action={movePlaybookStepAction}><input type="hidden" name="playbookId" value={p.id} /><input type="hidden" name="stepId" value={s.id} /><input type="hidden" name="direction" value="up" /><button className="btn btn-secondary btn-small" type="submit" aria-label={`Schritt ${s.position} nach oben`}>↑</button></form>
              )}
              {i < p.steps.length - 1 && (
                <form action={movePlaybookStepAction}><input type="hidden" name="playbookId" value={p.id} /><input type="hidden" name="stepId" value={s.id} /><input type="hidden" name="direction" value="down" /><button className="btn btn-secondary btn-small" type="submit" aria-label={`Schritt ${s.position} nach unten`}>↓</button></form>
              )}
              <form action={removePlaybookStepAction}><input type="hidden" name="playbookId" value={p.id} /><input type="hidden" name="stepId" value={s.id} /><button className="btn btn-secondary btn-small" type="submit">Entfernen</button></form>
            </div>
          </div>
          <form action={updatePlaybookStepAction} className="grid sm:grid-cols-2 gap-3">
            <input type="hidden" name="playbookId" value={p.id} />
            <input type="hidden" name="stepId" value={s.id} />
            <StepFields prefix={s.id} s={s} />
            <div className="sm:col-span-2"><button className="btn btn-secondary" type="submit">Schritt speichern</button></div>
          </form>
        </section>
      ))}

      <section className="card">
        <h2 className="font-semibold mb-2">Schritt ergänzen</h2>
        <form action={addPlaybookStepAction} className="grid sm:grid-cols-2 gap-3">
          <input type="hidden" name="playbookId" value={p.id} />
          <StepFields prefix="new" s={{}} />
          <div className="sm:col-span-2"><button className="btn" type="submit">Schritt anhängen</button></div>
        </form>
      </section>
    </div>
  );
}
