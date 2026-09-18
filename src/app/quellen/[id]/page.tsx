import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { getSource } from "@/modules/knowledge/service";
import { Status } from "@/components/Status";
import { accessClassLabel, epistemicLabel, fmtDateTime, sourceTypeLabel } from "@/lib/labels";

export default async function QuellePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let q;
  try {
    q = await getSource(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  return (
    <div className="space-y-6 max-w-3xl">
      <p className="text-sm">{q.setup ? <Link href={`/setups/${q.setup.id}`}>← Zurück zum Setup „{q.setup.name}“</Link> : <Link href="/meine-arbeit">← Meine Arbeit</Link>}</p>
      <h1 className="text-2xl font-semibold">{q.source.title}</h1>
      <section className="card">
        <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <div><dt className="muted">Typ</dt><dd>{sourceTypeLabel[q.source.type] ?? q.source.type}</dd></div>
          <div><dt className="muted">Herkunft</dt><dd>{q.source.origin ?? "–"}</dd></div>
          <div><dt className="muted">Quellenzeit</dt><dd>{fmtDateTime(q.source.sourceTime)}</dd></div>
          <div><dt className="muted">Erfasst</dt><dd>{fmtDateTime(q.source.importedAt)}</dd></div>
          <div><dt className="muted">Inhaber</dt><dd>{q.ownerName}</dd></div>
          <div><dt className="muted">Zugriff</dt><dd>{accessClassLabel[q.source.accessClass]}</dd></div>
        </dl>
        <p className="muted text-sm mt-3">Eine Quelle belegt zunächst eine Aussage, nicht automatisch ihre Richtigkeit oder Bindungswirkung (Briefing 13.3).</p>
      </section>
      <section className="card">
        <h2 className="font-semibold mb-2">Inhalt (Originalquelle)</h2>
        <pre className="whitespace-pre-wrap text-sm" style={{ fontFamily: "inherit" }}>{q.source.body ?? "(kein Text hinterlegt)"}</pre>
      </section>
      {q.evidence.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Aussagen, die sich auf diese Quelle stützen</h2>
          <ul className="space-y-1 text-sm">
            {q.evidence.map((e) => (
              <li key={e.assertionId} className="flex gap-2 items-baseline"><Status label={epistemicLabel[e.epistemicStatus] ?? e.epistemicStatus} /> <span>{e.content}</span></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
