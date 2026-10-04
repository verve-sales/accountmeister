import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { canRunMocoImport } from "@/modules/moco/import";
import { hintKindLabel, listHints, mocoStatus, type HintKind } from "@/modules/moco/sync";
import { listImports } from "@/modules/moco/import";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { fmtDateTime } from "@/lib/labels";
import { mocoDiscardImportAction, mocoPreviewAction, mocoSyncNowAction } from "../actions";
import { HintButtons } from "@/components/MocoHints";

const STATUS_LABEL: Record<string, string> = { ENTWURF: "Vorschau (offen)", UEBERNOMMEN: "übernommen", VERWORFEN: "verworfen" };

export default async function MocoPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const importer = canRunMocoImport(actor);
  const [status, hints, imports] = await Promise.all([mocoStatus(actor), listHints(actor, { status: "OFFEN" }), importer ? listImports(actor) : Promise.resolve([])]);
  if (!importer && hints.length === 0) notFound();
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Moco</h1>
        <span className="muted text-sm">Moco führt Stammdaten, Projekte, Zuweisungen und Zeiten; der Accountmeister führt Vertrieb, Besetzung und Betreuung. Abgleich nur in Richtung Moco → Accountmeister, nie stillschweigend.</span>
      </div>
      <Feedback params={sp} />

      {importer && (
        <section className="card text-sm space-y-2">
          <h2 className="font-semibold">Verbindung</h2>
          <p>
            Modus: <strong>{status.mode}</strong>
            {status.subdomain ? ` · ${status.subdomain}.mocoapp.com` : ""} · Webhook-Signatur {status.webhookConfigured ? "hinterlegt" : "fehlt (MOCO_WEBHOOK_SECRET)"} · letzter Abgleich: {status.lastRun ? `${fmtDateTime(status.lastRun.startedAt)} (${status.lastRun.ok ? "ok" : `Fehler: ${status.lastRun.error}`})` : "noch keiner"}
          </p>
          {!status.enabled && <p className="muted">Die Anbindung ist aus. In <code>.env.production</code> setzen: <code>MOCO_MODE=http</code>, <code>MOCO_SUBDOMAIN</code>, <code>MOCO_API_KEY</code> (technischer Nutzer, nur lesen), optional <code>MOCO_WEBHOOK_SECRET</code>. Webhook-Ziel: <code>/api/moco/webhook</code> (Targets Project, Company, User; Events create/update/delete).</p>}
          {status.enabled && (
            <div className="flex flex-wrap gap-3 items-end">
              <form action={mocoPreviewAction}>
                <input type="hidden" name="back" value="/moco" />
                <button className="btn btn-small" type="submit">Vorschau aus Moco laden (Prüfliste)</button>
              </form>
              <form action={mocoSyncNowAction} className="flex gap-2 items-end">
                <input type="hidden" name="back" value="/moco" />
                <div><label className="label" htmlFor="since">Abgleich ab (leer = seit letztem Lauf)</label><input id="since" type="date" name="since" className="input" /></div>
                <button className="btn btn-secondary btn-small" type="submit">Abgleich jetzt</button>
              </form>
            </div>
          )}
          {status.events.length > 0 && <p className="muted text-xs">Letzte Webhook-Ereignisse: {status.events.map((e) => `${e.target}/${e.event}${e.signatureOk ? "" : " (Signatur!)"}${e.error ? " ✗" : ""}`).join(" · ")}</p>}
        </section>
      )}

      <section className="card" id="hinweise">
        <h2 className="font-semibold mb-2">Offene Hinweise aus Moco ({hints.length})</h2>
        {hints.length === 0 ? (
          <p className="muted text-sm">Keine Abweichungen. Hinweise entstehen, wenn Moco ein Projektende ändert, ein Projekt beendet, eine Zuweisung inaktiv setzt oder etwas Neues anlegt.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {hints.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline gap-2">
                <span className="status">{hintKindLabel[h.kind as HintKind] ?? h.kind}</span>
                <span>{h.title}</span>
                {h.subjectType === "ENGAGEMENT" && h.subjectId && <Link href={`/einsaetze/${h.subjectId}`} className="text-xs">Einsatz öffnen</Link>}
                <span className="muted text-xs">{fmtDateTime(h.createdAt)}</span>
                <HintButtons id={h.id} kind={h.kind as HintKind} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {importer && (
        <section className="card">
          <h2 className="font-semibold mb-2">Importläufe</h2>
          {imports.length === 0 ? <p className="muted text-sm">Noch kein Importlauf.</p> : (
            <ul className="space-y-1 text-sm">
              {imports.map((i) => (
                <li key={i.id} className="flex flex-wrap items-baseline gap-2">
                  <Link href={`/moco/import/${i.id}`}>{i.summary ?? i.id}</Link>
                  <span className="status">{STATUS_LABEL[i.status] ?? i.status}</span>
                  <span className="muted text-xs">{fmtDateTime(i.createdAt)}</span>
                  {i.status === "ENTWURF" && (
                    <form action={mocoDiscardImportAction} className="inline"><input type="hidden" name="importId" value={i.id} /><input type="hidden" name="back" value="/moco" /><button className="btn btn-secondary btn-small" type="submit">Verwerfen</button></form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

