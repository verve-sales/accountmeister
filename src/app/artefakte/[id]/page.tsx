import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { listVersions, requireArtifact, type ArtifactContent } from "@/modules/artifacts/service";
import { canViewSource } from "@/modules/identity/authz";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { accessClassLabel, artifactStatusLabel, artifactVariantLabel, fmtDateTime } from "@/lib/labels";
import { changeArtifactStatusAction, saveArtifactVersionAction } from "../../actions";

export default async function ArtefaktPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let a;
  try {
    a = await requireArtifact(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const { version: v, ctx, template, canEdit } = a;
  const content = v.content as ArtifactContent;
  const [versions, allSources, users] = await Promise.all([
    listVersions(actor, v.artifactKey),
    db.query.sources.findMany({ where: eq(schema.sources.setupId, ctx.setup.id) }),
    db.query.users.findMany({ where: inArray(schema.users.id, [...new Set([v.createdBy, v.approvedBy].filter((x): x is string => !!x))]) }),
  ]);
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const visibleSources = allSources.filter((s) => canViewSource(actor, s, ctx) && (v.variant === "INTERN" || s.accessClass !== "PERSOENLICH"));
  const isLatest = versions[0]?.id === v.id;
  const editable = canEdit && isLatest;
  const sectionsToShow = template.sections.filter((s) => v.variant === "INTERN" || s.externalAllowed);

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href={`/kunden/${ctx.account.id}`}>{ctx.account.name}</Link> › <Link href={`/setups/${ctx.setup.id}`}>{ctx.setup.name}</Link> › <Link href={`/setups/${ctx.setup.id}/artefakte`}>Artefakte</Link> › {v.title}
      </p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{v.title}</h1>
        <Status label={artifactStatusLabel[v.status] ?? v.status} />
        <span className="muted text-sm">{template.code} {template.name} · {artifactVariantLabel[v.variant]} · Version {v.versionNo} · Empfängerkreis: {accessClassLabel[v.audience]}</span>
      </div>
      <Feedback params={sp} />
      {!isLatest && <p className="error">Dies ist eine ältere Version. <Link href={`/artefakte/${versions[0]?.id}`}>Zur neuesten Version</Link>.</p>}
      {v.variant === "EXTERN" && <p className="text-sm" style={{ background: "var(--warn-soft)", color: "var(--warn)", padding: ".5rem .75rem", borderRadius: 6 }}>Kundentext: Nur zutreffende, freigegebene Angaben. Keine vertrauliche Herkunft, keine internen Bewertungen, keine nicht freigegebenen Projektdetails. Das System versendet nichts – Kopieren ist Ihre Handlung.</p>}

      <section className="card">
        <p className="muted text-sm mb-3">Qualitätskriterium: {template.qualityCriterion}</p>
        {editable && v.status !== "FREIGEGEBEN" ? (
          <form action={saveArtifactVersionAction} className="space-y-4">
            <input type="hidden" name="versionId" value={v.id} />
            <div><label className="label" htmlFor="title">Titel</label><input id="title" name="title" className="input" required minLength={3} defaultValue={v.title} /></div>
            {sectionsToShow.map((s) => (
              <div key={s.key}>
                <label className="label" htmlFor={`sec-${s.key}`}>{s.label}{s.required && " (Pflicht)"}</label>
                <p className="muted text-sm mb-1">{s.hint}</p>
                <textarea id={`sec-${s.key}`} name={`section:${s.key}`} className="textarea" defaultValue={content[s.key] ?? ""} />
              </div>
            ))}
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="audience">Empfängerkreis</label>
                <select id="audience" name="audience" className="select" defaultValue={v.audience}>{schema.accessClassEnum.enumValues.map((x) => <option key={x} value={x}>{accessClassLabel[x]}</option>)}</select>
              </div>
              <fieldset>
                <legend className="label">Referenzierte Quellen</legend>
                <div className="flex flex-col gap-1 text-sm max-h-40 overflow-auto">
                  {visibleSources.length === 0 && <span className="muted">Keine referenzierbaren Quellen.</span>}
                  {visibleSources.map((s) => (
                    <label key={s.id} className="flex items-center gap-2"><input type="checkbox" name="sourceIds" value={s.id} defaultChecked={v.sourceIds.includes(s.id)} /> {s.title} <span className="muted">({accessClassLabel[s.accessClass]})</span></label>
                  ))}
                </div>
              </fieldset>
            </div>
            <button className="btn" type="submit">Als neue Version speichern</button>
          </form>
        ) : (
          <div className="space-y-4">
            {sectionsToShow.map((s) => (
              <div key={s.key}>
                <h3 className="font-medium">{s.label}</h3>
                {content[s.key] ? <pre className="whitespace-pre-wrap text-sm" style={{ fontFamily: "inherit" }}>{content[s.key]}</pre> : <p className="muted text-sm">(leer)</p>}
              </div>
            ))}
            {v.sourceIds.length > 0 && (
              <p className="text-sm muted">Quellen: {v.sourceIds.map((sid) => { const src = visibleSources.find((x) => x.id === sid); return src ? <Link key={sid} href={`/quellen/${sid}`} className="mr-2">{src.title}</Link> : <span key={sid} className="mr-2">(nicht einsehbar)</span>; })}</p>
            )}
            {v.status === "FREIGEGEBEN" && editable && (
              <form action={saveArtifactVersionAction}>
                <input type="hidden" name="versionId" value={v.id} />
                <input type="hidden" name="title" value={v.title} />
                {sectionsToShow.map((s) => <input key={s.key} type="hidden" name={`section:${s.key}`} value={content[s.key] ?? ""} />)}
                {v.sourceIds.map((sid) => <input key={sid} type="hidden" name="sourceIds" value={sid} />)}
                <button className="btn btn-secondary btn-small" type="submit">Neue Bearbeitungsversion anlegen (Freigabe bleibt als Version
                {v.versionNo} erhalten)</button>
              </form>
            )}
          </div>
        )}
      </section>

      {editable && v.status !== "UEBERHOLT" && (
        <section className="card">
          <h2 className="font-semibold mb-2">Prüfung und Freigabe</h2>
          <form action={changeArtifactStatusAction} className="flex flex-wrap gap-3 items-end">
            <input type="hidden" name="versionId" value={v.id} />
            {v.status === "ENTWURF" && <button className="btn btn-secondary btn-small" name="status" value="GEPRUEFT">Als geprüft markieren</button>}
            {v.status === "GEPRUEFT" && <button className="btn btn-secondary btn-small" name="status" value="ENTWURF">Zurück zu Entwurf</button>}
            {v.status !== "FREIGEGEBEN" && (
              <>
                {v.variant === "EXTERN" && <label className="text-sm flex items-center gap-2"><input type="checkbox" name="confirmNoConfidential" value="true" /> Ich bestätige: keine vertrauliche Herkunft, interne Bewertung oder nicht freigegebenen Projektdetails.</label>}
                <button className="btn btn-small" name="status" value="FREIGEGEBEN">Freigeben</button>
              </>
            )}
          </form>
          <p className="muted text-sm mt-2">Freigabe = Inhalt darf im angegebenen Empfängerkreis verwendet werden. Sie ist kein Versand und erzeugt keinen Vorstellungs- oder Bestätigungsstatus (F09).</p>
        </section>
      )}

      <section className="card">
        <h2 className="font-semibold mb-2">Versionen ({versions.length})</h2>
        <ul className="text-sm space-y-1">
          {versions.map((x) => (
            <li key={x.id}>
              {x.id === v.id ? <strong>Version {x.versionNo}</strong> : <Link href={`/artefakte/${x.id}`}>Version {x.versionNo}</Link>} · <Status label={artifactStatusLabel[x.status] ?? x.status} /> · {fmtDateTime(x.createdAt)}
              {x.approvedBy && <span className="muted"> · freigegeben von {un.get(x.approvedBy) ?? "?"} {x.approvedAt && fmtDateTime(x.approvedAt)}</span>}
            </li>
          ))}
        </ul>
        <p className="muted text-sm mt-2">Angelegt von {un.get(v.createdBy) ?? "?"} · Vorlagenversion {v.templateVersion}</p>
      </section>
    </div>
  );
}
