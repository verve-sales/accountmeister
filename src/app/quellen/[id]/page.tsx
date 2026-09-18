import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { getSource } from "@/modules/knowledge/service";
import { Status } from "@/components/Status";
import { accessClassLabel, epistemicLabel, fmtDateTime, sourceTypeLabel } from "@/lib/labels";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { hasRole } from "@/modules/identity/actor";
import { eraseSourceAction, lockSourceAction } from "../../actions";

export default async function QuellePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
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
      <div className="flex flex-wrap items-baseline gap-3"><h1 className="text-2xl font-semibold">{q.source.title}</h1>{q.source.isLocked && <Status label="Gesperrt" />}</div>
      <Feedback params={sp} />
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
      {(q.source.ownerUserId === actor.userId || hasRole(actor, "PRINCIPAL") || hasRole(actor, "CEO")) && (
        <section className="card">
          <h2 className="font-semibold mb-2">Sperren und Löschen (Briefing 16.4)</h2>
          <p className="muted text-sm mb-2">Sperren markiert alle Vorschläge, Artefaktfassungen und Aussagen, die sich auf diese Quelle stützen, als „überholt“ – sie müssen erneut geprüft werden. Löschen entfernt danach den Inhalt; Typ, Zeitpunkte und Protokoll bleiben nachvollziehbar.</p>
          {!q.source.isLocked ? (
            <form action={lockSourceAction} className="flex flex-wrap gap-2 items-end">
              <input type="hidden" name="sourceId" value={q.source.id} />
              <div><label className="label" htmlFor="lockReason">Grund</label><input id="lockReason" name="reason" className="input" style={{ width: "24rem" }} required minLength={5} placeholder="z. B. Löschverlangen der Person, Vertraulichkeit" /></div>
              <button className="btn btn-secondary" type="submit">Quelle sperren</button>
            </form>
          ) : q.source.body !== null ? (
            <form action={eraseSourceAction} className="flex flex-wrap gap-2 items-end">
              <input type="hidden" name="sourceId" value={q.source.id} />
              <div><label className="label" htmlFor="eraseReason">Grund der Löschung</label><input id="eraseReason" name="reason" className="input" style={{ width: "24rem" }} required minLength={5} /></div>
              <button className="btn btn-secondary" type="submit">Inhalt endgültig entfernen</button>
            </form>
          ) : <p className="text-sm">Der Inhalt dieser Quelle wurde entfernt.</p>}
        </section>
      )}
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
