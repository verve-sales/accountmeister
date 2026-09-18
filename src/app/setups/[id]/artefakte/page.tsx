import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { schema } from "@/db/client";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { requireSetupContext } from "@/modules/setups/service";
import { canEditSetup } from "@/modules/identity/authz";
import { listArtifactsForSetup, templatesForSetupDrafts } from "@/modules/artifacts/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { accessClassLabel, artifactStatusLabel, artifactVariantLabel, fmtDateTime } from "@/lib/labels";
import { createArtifactDraftAction } from "../../../actions";

export default async function SetupArtefaktePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let ctx;
  try {
    ctx = await requireSetupContext(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const canEdit = canEditSetup(actor, ctx);
  const artifacts = await listArtifactsForSetup(actor, id);
  const templates = templatesForSetupDrafts();
  return (
    <div className="space-y-6">
      <p className="text-sm"><Link href="/kunden">Kunden</Link> › <Link href={`/kunden/${ctx.account.id}`}>{ctx.account.name}</Link> › <Link href={`/setups/${id}`}>{ctx.setup.name}</Link> › Artefakte</p>
      <h1 className="text-2xl font-semibold">Artefakte – {ctx.setup.name}</h1>
      <Feedback params={sp} />
      <section className="card">
        <h2 className="font-semibold mb-2">Textentwürfe ({artifacts.length})</h2>
        {artifacts.length === 0 ? <p className="muted text-sm">Noch keine Textentwürfe. Lebende Artefakte (Setup, Personen & Zugang, Hinweise, Übergaben, Kontaktwege, Weeklys, Accountplan) sind direkt als Ansichten vorhanden.</p> : (
          <table className="list">
            <thead><tr><th>Artefakt</th><th>Vorlage</th><th>Variante</th><th>Version</th><th>Status</th><th>Empfängerkreis</th><th>Zuletzt</th></tr></thead>
            <tbody>
              {artifacts.map((a) => (
                <tr key={a.id}>
                  <td><Link href={`/artefakte/${a.id}`}>{a.title}</Link></td>
                  <td>{a.templateCode} {a.templateName}</td>
                  <td>{artifactVariantLabel[a.variant]}</td>
                  <td>{a.versionNo}</td>
                  <td><Status label={artifactStatusLabel[a.status] ?? a.status} />{a.approvedByName && <div className="muted text-sm">von {a.approvedByName}</div>}</td>
                  <td className="text-sm">{accessClassLabel[a.audience]}</td>
                  <td className="text-sm">{fmtDateTime(a.createdAt)} · {a.createdByName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {canEdit && (
        <section className="card">
          <h2 className="font-semibold mb-2">Artefakt entwerfen</h2>
          <form action={createArtifactDraftAction} className="grid sm:grid-cols-2 gap-3">
            <input type="hidden" name="setupId" value={id} />
            <div>
              <label className="label" htmlFor="templateCode">Vorlage</label>
              <select id="templateCode" name="templateCode" className="select" required defaultValue="A6">
                {templates.map((t) => <option key={t.code} value={t.code}>{t.code} {t.name}{t.implementation === "FOLGT" ? " (Objektbezug folgt)" : ""}</option>)}
              </select>
            </div>
            <div><label className="label" htmlFor="artTitle">Titel (optional)</label><input id="artTitle" name="title" className="input" /></div>
            <div>
              <label className="label" htmlFor="variant">Variante</label>
              <select id="variant" name="variant" className="select" defaultValue="INTERN">
                <option value="INTERN">Interne Notiz (wird aus Daten vorbefüllt)</option>
                <option value="EXTERN">Kundentext (startet leer; nur bei A5/A9 zulässig)</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="audience">Zulässiger Empfängerkreis</label>
              <select id="audience" name="audience" className="select" defaultValue="SETUP">{schema.accessClassEnum.enumValues.map((v) => <option key={v} value={v}>{accessClassLabel[v]}</option>)}</select>
            </div>
            <div className="sm:col-span-2"><button className="btn" type="submit">Entwurf anlegen</button></div>
          </form>
          <p className="muted text-sm mt-2">Vorbefüllte Inhalte sind Vorschläge aus berechtigten Daten, keine bestätigten Aussagen. Coaching-/Eskalationsnotizen (A14) brauchen den Empfängerkreis „persönlich“ oder „Kundenteam“.</p>
        </section>
      )}
    </div>
  );
}
