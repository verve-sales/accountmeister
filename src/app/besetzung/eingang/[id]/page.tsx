import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { DomainError } from "@/lib/errors";
import { getConfig } from "@/lib/config";
import { getIntake } from "@/modules/staffing/ai";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { applyStaffingIntakeAction } from "../../../actions";

export default async function IntakePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  if (getConfig().FEATURE_BESETZUNG !== "true") notFound();
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let d;
  try {
    d = await getIntake(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const back = `/besetzung/eingang/${id}`;
  const decided = d.intake.status !== "OFFEN";
  return (
    <div className="space-y-5">
      <p className="text-sm"><Link href={`/bedarfe/${d.opportunity.id}#besetzung`}>{d.opportunity.title}</Link> · Texteingang</p>
      <h1 className="text-2xl font-semibold">Vorschläge aus dem Text prüfen</h1>
      <Feedback params={sp} />
      <section className="card text-sm">
        <p className="muted">{d.proposal.note} {d.proposal.summary}</p>
        {d.proposal.missing.length > 0 && <p className="mt-1"><strong>Offen / nachfragen:</strong> {d.proposal.missing.join(" · ")}</p>}
        {decided && <p className="mt-1">Dieser Eingang wurde bereits {d.intake.status === "UEBERNOMMEN" ? "übernommen" : "verworfen"}.</p>}
      </section>
      <form action={applyStaffingIntakeAction} className="space-y-3">
        <input type="hidden" name="intakeId" value={id} />
        <input type="hidden" name="opportunityId" value={d.opportunity.id} />
        <input type="hidden" name="back" value={back} />
        {d.proposal.positions.length === 0 && <section className="card text-sm muted">Keine Position erkannt. Lege sie bitte manuell an der Chance an – der Text bleibt als Quelle erhalten.</section>}
        {d.proposal.positions.map((x, idx) => (
          <section key={idx} className="card text-sm">
            <div className="flex flex-wrap gap-3 items-end">
              <label className="flex items-center gap-2"><input type="checkbox" name={`take_${idx}`} value="on" defaultChecked disabled={decided} /> Übernehmen als Entwurf</label>
              <div className="grow"><label className="label" htmlFor={`t-${idx}`}>Titel / Rolle</label><input id={`t-${idx}`} name={`title_${idx}`} className="input" defaultValue={x.title} disabled={decided} /></div>
            </div>
            <dl className="grid sm:grid-cols-3 gap-x-6 gap-y-1 mt-2">
              <div><dt className="muted">Start</dt><dd>{x.desiredStart || x.startHint || "–"}</dd></div>
              <div><dt className="muted">Ende</dt><dd>{x.plannedEnd || x.endHint || "offen"}</dd></div>
              <div><dt className="muted">Umfang</dt><dd>{x.scopeText || "–"}</dd></div>
              <div><dt className="muted">Ort</dt><dd>{x.location || "–"}</dd></div>
              <div><dt className="muted">Sprache</dt><dd>{x.language || "–"}</dd></div>
              <div><dt className="muted">Hinweis zu Sätzen (nur Notiz, kein EK)</dt><dd>{x.rateHint || "–"}</dd></div>
              <div className="sm:col-span-3"><dt className="muted">Muss</dt><dd style={{ whiteSpace: "pre-wrap" }}>{x.mustHave || "–"}</dd></div>
              <div className="sm:col-span-3"><dt className="muted">Kann</dt><dd style={{ whiteSpace: "pre-wrap" }}>{x.niceToHave || "–"}</dd></div>
              <div className="sm:col-span-3"><dt className="muted">Aufgaben</dt><dd style={{ whiteSpace: "pre-wrap" }}>{x.tasks || "–"}</dd></div>
              <div className="sm:col-span-3"><dt className="muted">Belegstelle</dt><dd className="muted">„{x.evidenceQuote}“</dd></div>
            </dl>
          </section>
        ))}
        {!decided && (
          <div className="flex flex-wrap gap-2">
            {d.proposal.positions.length > 0 && <button className="btn btn-small" type="submit" name="decision" value="UEBERNEHMEN">Ausgewählte als Entwurf anlegen</button>}
            <button className="btn btn-secondary btn-small" type="submit" name="decision" value="VERWERFEN">Eingang verwerfen</button>
          </div>
        )}
      </form>
      <details className="card text-sm">
        <summary>Eingefügter Text (Quelle am Setup)</summary>
        <pre className="mt-2" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{d.sourceBody}</pre>
      </details>
    </div>
  );
}
