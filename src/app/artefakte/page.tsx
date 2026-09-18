import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { listTemplates } from "@/modules/artifacts/service";
import { TEMPLATE_REGISTRY_VERSION } from "@/modules/artifacts/templates";
import { listMySetups } from "@/modules/setups/service";
import { Status } from "@/components/Status";
import { implementationLabel } from "@/lib/labels";

export default async function ArtefakteKatalogPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const templates = listTemplates();
  const setups = await listMySetups(actor);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Artefaktkatalog</h1>
      <p className="muted text-sm">
        Alle {templates.length} Arbeitsergebnisse aus dem Briefing (A1–A16 sowie Setup, Weekly-Protokoll, Zielvereinbarung) sind registriert – Registerversion {TEMPLATE_REGISTRY_VERSION}. Artefakte entstehen im jeweiligen Kontext (Setup, Kunde, Weekly), nicht über diese Liste. Kein Vorgang muss alle Artefakte anlegen.
      </p>
      <section className="card">
        <table className="list">
          <thead><tr><th>Nr.</th><th>Arbeitsergebnis</th><th>Verantwortlich / Auslöser</th><th>Umsetzung</th><th>Qualitätskriterium</th></tr></thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.code}>
                <td>{t.code}</td>
                <td>{t.name}{t.externalVariantAllowed && <div className="muted text-sm">Kundentext-Variante möglich</div>}</td>
                <td className="text-sm">{t.responsible}<div className="muted">{t.trigger}</div></td>
                <td><Status label={implementationLabel[t.implementation] ?? t.implementation} />{t.sections.length > 0 && <div className="muted text-sm">{t.sections.length} Abschnitte</div>}</td>
                <td className="text-sm muted">{t.qualityCriterion}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {setups.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-1">Textentwürfe anlegen</h2>
          <p className="text-sm">In einem Setup: {setups.map((s, i) => <span key={s.id}>{i > 0 && ", "}<Link href={`/setups/${s.id}/artefakte`}>{s.name}</Link></span>)}</p>
        </section>
      )}
    </div>
  );
}
