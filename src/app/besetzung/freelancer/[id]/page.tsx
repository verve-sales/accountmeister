import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { getConfig } from "@/lib/config";
import { DomainError } from "@/lib/errors";
import { candidacyStatusLabel, getFreelancerDetail } from "@/modules/staffing/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { fmtDate } from "@/lib/labels";
import { updateFreelancerAction } from "../../../actions";

export default async function FreelancerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  if (getConfig().FEATURE_BESETZUNG !== "true") notFound();
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let d;
  try {
    d = await getFreelancerDetail(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const f = d.freelancer;
  const back = `/besetzung/freelancer/${id}`;
  return (
    <div className="space-y-5">
      <p className="text-sm"><Link href="/besetzung">Besetzungen</Link></p>
      <h1 className="text-2xl font-semibold">{f.displayName}</h1>
      <Feedback params={sp} />
      <section className="card text-sm">
        <dl className="grid sm:grid-cols-3 gap-x-6 gap-y-1">
          <div><dt className="muted">E-Mail / Telefon</dt><dd>{f.email ?? "–"}{f.phone ? ` · ${f.phone}` : ""}</dd></div>
          <div><dt className="muted">Firma</dt><dd>{f.company ?? "–"}</dd></div>
          <div><dt className="muted">Skills</dt><dd>{f.skills ?? "–"}</dd></div>
          <div><dt className="muted">Verfügbarkeit</dt><dd>{f.availabilityNote ?? "–"}{f.availabilityAsOf ? ` (Stand ${fmtDate(f.availabilityAsOf)}${f.availabilitySource ? `, ${f.availabilitySource}` : ""})` : ""}</dd></div>
          <div><dt className="muted">CV-Referenz (extern)</dt><dd>{f.externalCvRef ?? "–"}</dd></div>
          <div><dt className="muted">Tool-Referenz (extern)</dt><dd>{f.externalToolRef ?? "–"}</dd></div>
        </dl>
        <details className="mt-3">
          <summary>Stammdaten bearbeiten</summary>
          <form action={updateFreelancerAction} className="grid sm:grid-cols-3 gap-2 mt-2">
            <input type="hidden" name="freelancerId" value={f.id} /><input type="hidden" name="version" value={f.version} /><input type="hidden" name="back" value={back} />
            <div><label className="label">Name</label><input name="displayName" className="input" defaultValue={f.displayName} required /></div>
            <div><label className="label">E-Mail</label><input name="email" className="input" defaultValue={f.email ?? ""} /></div>
            <div><label className="label">Telefon</label><input name="phone" className="input" defaultValue={f.phone ?? ""} /></div>
            <div><label className="label">Firma</label><input name="company" className="input" defaultValue={f.company ?? ""} /></div>
            <div className="sm:col-span-2"><label className="label">Skills</label><input name="skills" className="input" defaultValue={f.skills ?? ""} /></div>
            <div><label className="label">Verfügbarkeit</label><input name="availabilityNote" className="input" defaultValue={f.availabilityNote ?? ""} /></div>
            <div><label className="label">Stand</label><input type="date" name="availabilityAsOf" className="input" defaultValue={f.availabilityAsOf ?? ""} /></div>
            <div><label className="label">Quelle</label><input name="availabilitySource" className="input" defaultValue={f.availabilitySource ?? ""} /></div>
            <div><label className="label">CV-Referenz</label><input name="externalCvRef" className="input" defaultValue={f.externalCvRef ?? ""} /></div>
            <div><label className="label">Tool-Referenz</label><input name="externalToolRef" className="input" defaultValue={f.externalToolRef ?? ""} /></div>
            <div className="sm:col-span-3"><button className="btn btn-small" type="submit">Speichern</button></div>
          </form>
        </details>
      </section>
      <section className="card text-sm">
        <h2 className="font-semibold mb-2">Kandidaturen in deinem Sichtbereich ({d.candidacies.length})</h2>
        {d.candidacies.length === 0 ? <p className="muted">Keine sichtbaren Kandidaturen.</p> : (
          <ul className="space-y-1">
            {d.candidacies.map((c) => (
              <li key={c.candidacy.id}><Link href={`/besetzung/${c.position.id}`}>{c.position.title}</Link> · {c.accountName} · {candidacyStatusLabel[c.candidacy.status] ?? c.candidacy.status} · {fmtDate(c.candidacy.createdAt)}</li>
            ))}
          </ul>
        )}
        {d.hiddenCount > 0 && <p className="muted text-xs mt-2">{d.hiddenCount} weitere Kandidatur(en) bei anderen Kunden sind für dich nicht sichtbar.</p>}
      </section>
    </div>
  );
}
