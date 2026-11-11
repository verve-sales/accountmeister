import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { getConfig } from "@/lib/config";
import { DomainError } from "@/lib/errors";
import { candidacyStatusLabel, getFreelancerDetail } from "@/modules/staffing/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { fmtDate } from "@/lib/labels";
import { saveFreelancerProfileAction, updateFreelancerAction } from "../../../actions";
import { getFreelancerProfile } from "@/modules/conversion/profile";
import { engagementStatusLabel } from "@/modules/engagements/service";

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
  const prof = await getFreelancerProfile(actor, id);
  const pf = prof.freelancer;
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
      <section className="card text-sm space-y-3" id="profil">
        <h2 className="font-semibold">Profil</h2>
        <dl className="grid sm:grid-cols-3 gap-x-6 gap-y-1">
          <div><dt className="muted">Vertragspartner</dt><dd>{pf.legalForm === "GESELLSCHAFT" ? `Gesellschaft${pf.company ? `: ${pf.company}` : ""}` : "Einzelperson"}</dd></div>
          <div><dt className="muted">Vertragsanschrift</dt><dd>{pf.street || pf.postalCity ? `${pf.street ?? "?"}, ${pf.postalCity ?? "?"}` : <span style={{ color: "#b7791f" }}>fehlt (für den Vertrag nötig)</span>}</dd></div>
          <div><dt className="muted">Wohnort</dt><dd>{pf.residence ?? "–"}</dd></div>
          {pf.legalForm === "GESELLSCHAFT" && <div><dt className="muted">Vertreten durch</dt><dd>{pf.representativeName ? `${pf.representativeRole ?? ""} ${pf.representativeName}`.trim() : <span style={{ color: "#b7791f" }}>fehlt</span>}</dd></div>}
          <div><dt className="muted">Rollen</dt><dd>{pf.roles ?? "–"}</dd></div>
          <div><dt className="muted">Branchen</dt><dd>{pf.industries ?? "–"}</dd></div>
          <div><dt className="muted">Sprachen · Zertifikate</dt><dd>{[pf.languages, pf.certificates].filter(Boolean).join(" · ") || "–"}</dd></div>
          <div><dt className="muted">Frei ab · Umfang</dt><dd>{pf.availableFrom ? fmtDate(pf.availableFrom) : "–"}{pf.capacityNote ? ` · ${pf.capacityNote}` : ""}</dd></div>
          <div><dt className="muted">Einsatzort · Reise</dt><dd>{pf.travelNote ?? "–"}</dd></div>
          <div><dt className="muted">Profil in SharePoint</dt><dd>{pf.profileLink ? <a href={pf.profileLink} target="_blank" rel="noreferrer">öffnen</a> : "–"}</dd></div>
        </dl>
        {prof.showConditions ? (
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <h3 className="font-semibold">Konditionen <span className="muted text-xs font-normal">– nur Geschäftsführung, Sales Operations, Backoffice und der BD eines Einsatzes; jeder Aufruf wird protokolliert</span></h3>
            <p>Einkaufssatz: {pf.ekRate ? <strong>{Number(pf.ekRate).toLocaleString("de-DE", { minimumFractionDigits: 2 })} EUR je {pf.ekUnit === "TAG" ? "Tag" : "Stunde"}</strong> : "offen"} · Zahlungsziel: {pf.paymentTermDays ? `${pf.paymentTermDays} Tage` : "offen"}</p>
            {prof.rateHistory.length > 0 && <ul className="text-xs muted">{prof.rateHistory.map((r, i) => <li key={i}>{r.from ? fmtDate(r.from) : "?"}: {Number(r.ek).toLocaleString("de-DE", { minimumFractionDigits: 2 })} EUR je {r.unit === "TAG" ? "Tag" : "Stunde"} – <Link href={`/einsaetze/${r.engagementId}`}>{r.title}</Link></li>)}</ul>}
          </div>
        ) : <p className="muted text-xs">Konditionen sehen Geschäftsführung, Sales Operations, Backoffice und der BD eines Einsatzes dieses Freelancers.</p>}
        {prof.showContractual && (
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <h3 className="font-semibold">Vertragliches <span className="muted text-xs font-normal">– Geschäftsführung, Sales Operations, Backoffice</span></h3>
            <p>Steuernummer: {pf.taxNumber ?? "–"} · Rechnungsdaten: {pf.invoiceNote ?? "–"}</p>
          </div>
        )}
        <div>
          <h3 className="font-semibold">Projekte bei uns ({prof.projects.length})</h3>
          {prof.projects.length === 0 ? <p className="muted">Noch kein Einsatz.</p> : <ul className="space-y-0.5">{prof.projects.map((x) => <li key={x.engagementId}><Link href={`/einsaetze/${x.engagementId}`}>{x.title}</Link> · {x.accountName} · {x.start ? fmtDate(x.start) : "?"} – {x.end ? fmtDate(x.end) : "offen"} <span className="muted">({engagementStatusLabel[x.status] ?? x.status})</span></li>)}</ul>}
        </div>
        <details>
          <summary>Profil bearbeiten</summary>
          <form action={saveFreelancerProfileAction.bind(null, f.id)} className="grid sm:grid-cols-3 gap-2 mt-2">
            <input type="hidden" name="version" value={pf.version} />
            <div><label className="label">Vertragspartner</label><select name="legalForm" className="select" defaultValue={pf.legalForm}><option value="PERSON">Einzelperson</option><option value="GESELLSCHAFT">Gesellschaft (Firma unter Stammdaten)</option></select></div>
            <div><label className="label">Straße und Hausnummer</label><input name="street" className="input" defaultValue={pf.street ?? ""} /></div>
            <div><label className="label">PLZ und Ort</label><input name="postalCity" className="input" defaultValue={pf.postalCity ?? ""} /></div>
            <div><label className="label">Wohnort</label><input name="residence" className="input" defaultValue={pf.residence ?? ""} /></div>
            <div><label className="label">Vertreten durch (Name)</label><input name="representativeName" className="input" defaultValue={pf.representativeName ?? ""} placeholder="nur bei Gesellschaft" /></div>
            <div><label className="label">Funktion</label><input name="representativeRole" className="input" defaultValue={pf.representativeRole ?? ""} placeholder="z. B. den Geschäftsführer" /></div>
            <div><label className="label">Rollen</label><input name="roles" className="input" defaultValue={pf.roles ?? ""} /></div>
            <div><label className="label">Branchen</label><input name="industries" className="input" defaultValue={pf.industries ?? ""} /></div>
            <div><label className="label">Sprachen</label><input name="languages" className="input" defaultValue={pf.languages ?? ""} /></div>
            <div><label className="label">Zertifikate</label><input name="certificates" className="input" defaultValue={pf.certificates ?? ""} /></div>
            <div><label className="label">Frei ab</label><input type="date" name="availableFrom" className="input" defaultValue={pf.availableFrom ?? ""} /></div>
            <div><label className="label">Umfang</label><input name="capacityNote" className="input" defaultValue={pf.capacityNote ?? ""} placeholder="z. B. 4 Tage je Woche" /></div>
            <div><label className="label">Einsatzort und Reisebereitschaft</label><input name="travelNote" className="input" defaultValue={pf.travelNote ?? ""} /></div>
            <div className="sm:col-span-2"><label className="label">Link zum Profil in SharePoint</label><input name="profileLink" className="input" defaultValue={pf.profileLink ?? ""} /></div>
            {prof.showConditions && (
              <>
                <div><label className="label">Einkaufssatz (EUR)</label><input name="ekRate" className="input" inputMode="decimal" defaultValue={pf.ekRate ? String(pf.ekRate).replace(".", ",") : ""} /></div>
                <div><label className="label">je</label><select name="ekUnit" className="select" defaultValue={pf.ekUnit}><option value="STUNDE">Stunde</option><option value="TAG">Tag</option></select></div>
                <div><label className="label">Zahlungsziel (Tage)</label><input name="paymentTermDays" className="input" inputMode="numeric" defaultValue={pf.paymentTermDays ?? ""} /></div>
              </>
            )}
            {prof.showContractual && (
              <>
                <div><label className="label">Steuernummer</label><input name="taxNumber" className="input" defaultValue={pf.taxNumber ?? ""} /></div>
                <div className="sm:col-span-2"><label className="label">Rechnungsdaten fürs Backoffice</label><input name="invoiceNote" className="input" defaultValue={pf.invoiceNote ?? ""} /></div>
              </>
            )}
            <div className="sm:col-span-3"><button className="btn btn-small" type="submit">Profil speichern</button></div>
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
