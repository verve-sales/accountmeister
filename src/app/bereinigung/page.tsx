import Link from "next/link";
import { pl } from "@/lib/labels";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { canClean, cleanupReport } from "@/modules/cleanup/service";
import { engagementStatusLabel } from "@/modules/engagements/service";
import { Feedback } from "@/components/Feedback";
import { PendingButton } from "@/components/PendingButton";
import { EngagementMergeForm, SetupMergeForm } from "@/components/MergeForms";
import { fmtDate } from "@/lib/labels";
import { cleanupCloseOverdueAction, cleanupInternalAction, cleanupMergeFreelancersAction, cleanupMergePersonsAction } from "@/app/actions";

export const metadata = { title: "Bereinigung" };

function Count({ n }: { n: number }) {
  return <span className="status" style={n ? { background: "#fdf2e0", color: "#8a5a00" } : undefined}>{n}</span>;
}

export default async function BereinigungPage({ searchParams }: { searchParams: Promise<{ fehler?: string; ok?: string }> }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!canClean(actor)) notFound();
  const r = await cleanupReport(actor);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Bereinigung</h1>
        <span className="muted text-sm">Unstimmigkeiten im Bestand. Nichts ändert sich von selbst – jede Korrektur gibst du hier frei.</span>
        <Link href="/vertragsbuero" className="text-sm ml-auto">Sales-Ops-Sicht</Link>
      </div>
      <Feedback params={sp} />
      {r.total === 0 && <section className="card"><p className="text-sm">Alles sauber – keine Dubletten, keine überfälligen Einsätze, keine internen Moco-Projekte.</p></section>}

      <nav className="flex flex-wrap gap-3 text-sm" aria-label="Abschnitte">
        <a href="#ende">Ende überschritten <Count n={r.overdue.length} /></a>
        <a href="#plausibel">Plausibilität <Count n={r.plausibility.length} /></a>
        <a href="#freelancer">Doppelte Freelancer <Count n={r.freelancerDuplicates.length} /></a>
        <a href="#einsaetze">Doppelte Einsätze <Count n={r.engagementDuplicates.length} /></a>
        <a href="#intern">Interne Moco-Projekte <Count n={r.internal.length} /></a>
        <a href="#setups">Doppelte Setups <Count n={r.setupDuplicates.length} /></a>
        <a href="#personen">Doppelte Personen <Count n={r.personDuplicates.length} /></a>
      </nav>

      <section className="card space-y-2" id="ende">
        <h2 className="font-semibold">Einsätze mit überschrittenem Ende ({r.overdue.length})</h2>
        <p className="muted text-sm">Das Enddatum liegt zurück, der Einsatz steht aber noch auf aktiv oder endet. Abschließen setzt ihn zum Enddatum auf beendet und abgeschlossen. Ist eine Verlängerung noch offen, bleibt er auf „endet“, bis sie entschieden ist. Wurde tatsächlich verlängert: im Einsatz das neue Ende eintragen statt abzuschließen.</p>
        {r.overdue.length > 0 && (
          <form action={cleanupCloseOverdueAction} className="space-y-2">
            <table className="list text-sm">
              <thead><tr><th><span className="sr-only">Auswahl</span></th><th>Person · Kunde</th><th>Einsatz</th><th>Ende</th><th>Status</th></tr></thead>
              <tbody>
                {r.overdue.map((e) => (
                  <tr key={e.id}>
                    <td><input type="checkbox" name="id" value={e.id} defaultChecked aria-label={`${e.personName} auswählen`} /></td>
                    <td><strong>{e.personName}</strong><div className="muted text-xs">{e.accountName}</div></td>
                    <td><Link href={`/einsaetze/${e.id}`}>{e.title}</Link></td>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDate(e.end)}</td>
                    <td className="text-xs">{engagementStatusLabel[e.status] ?? e.status}{e.renewalOpen ? <div style={{ color: "#8a5a00" }}>Verlängerung offen</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <PendingButton busy="Schließe ab …">Ausgewählte abschließen</PendingButton>
          </form>
        )}
      </section>

      <section className="card space-y-2" id="plausibel">
        <h2 className="font-semibold">Plausibilität ({r.plausibility.length})</h2>
        <p className="muted text-sm">Angaben, die Zahlen in Health-Check, Zeitleiste und Kundenrunde verfälschen. Korrigiert wird am verlinkten Eintrag.</p>
        {r.plausibility.length > 0 && (
          <ul className="text-sm space-y-1">
            {r.plausibility.map((f, i) => <li key={`${f.kind}-${f.href}-${i}`}><span className="status">{f.kind === "OHNE_ENDE" ? "ohne Ende" : f.kind === "ENDE_VOR_START" ? "Ende vor Start" : "Kunde doppelt"}</span> <Link href={f.href}>{f.title}</Link> <span className="muted text-xs">{f.detail}</span></li>)}
          </ul>
        )}
      </section>

      <section className="card space-y-2" id="freelancer">
        <h2 className="font-semibold">Doppelte Freelancer ({r.freelancerDuplicates.length})</h2>
        <p className="muted text-sm">Gleicher Name (Schreibweise, Reihenfolge und Zusätze wie „(fiktiv)“ egal) oder gleiche E-Mail. Der fett markierte Datensatz bleibt; Einsätze, Kandidaturen, Unterlagen und fehlende Stammdaten ziehen um. Danach die Einsätze unter „Doppelte Einsätze“ zusammenführen.</p>
        {r.freelancerDuplicates.map((g) => (
          <form key={g.keep.id} action={cleanupMergeFreelancersAction} className="text-sm" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <input type="hidden" name="keep" value={g.keep.id} />
            {g.drop.map((d) => <input key={d.id} type="hidden" name="drop" value={d.id} />)}
            <div className="flex flex-wrap gap-2 items-baseline">
              <span><strong>{g.name}</strong> <span className="muted text-xs">{g.drop.length + 1}× angelegt · {g.reason}</span></span>
              <PendingButton busy="Führe zusammen …" className="btn btn-small ml-auto">Zusammenführen</PendingButton>
            </div>
            <ul className="muted text-xs mt-1" style={{ listStyle: "none", padding: 0 }}>
              {[g.keep, ...g.drop].map((f, i) => (
                <li key={f.id} style={i === 0 ? { color: "var(--text)", fontWeight: 600 } : undefined}>
                  {i === 0 ? "bleibt: " : "geht auf: "}<Link href={`/besetzung/freelancer/${f.id}`}>{f.name}</Link>{f.email ? ` · ${f.email}` : ""}{f.moco ? " · Moco" : ""} · {f.engagements} Einsätze · {f.candidacies} Kandidaturen
                </li>
              ))}
            </ul>
          </form>
        ))}
      </section>

      <section className="card space-y-3" id="einsaetze">
        <h2 className="font-semibold">Doppelte Einsätze ({r.engagementDuplicates.length})</h2>
        <p className="muted text-sm">Gleiche Person beim gleichen Kunden mit überlappender Laufzeit. Beim Zusammenführen bleibt der gewählte Einsatz; Moco-Verknüpfung, Auftrag, Enddatum und Ansprechpartner kommen dazu, wo er selbst nichts hat; Check-ins, Unterlagen, Betreuung und Verlängerung ziehen um. Der andere wird entfernt.</p>
        {r.engagementDuplicates.map((g) => <EngagementMergeForm key={g.keep.id} g={g} />)}
      </section>

      <section className="card space-y-2" id="intern">
        <h2 className="font-semibold">Interne Moco-Projekte ({r.internal.length})</h2>
        <p className="muted text-sm">Projekte mit Kunde „Verve Consulting“ sind interne Aktivitäten. Der Moco-Abgleich schlägt sie nicht mehr vor; früher übernommene werden hier entfernt und der Kunde archiviert.</p>
        {r.internal.map((a) => (
          <form key={a.accountId} action={cleanupInternalAction} className="text-sm space-y-1" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <input type="hidden" name="accountId" value={a.accountId} />
            <div><Link href={`/kunden/${a.accountId}`}><strong>{a.accountName}</strong></Link> <span className="muted text-xs">– {pl(a.engagements.length, "Einsatz", "Einsätze")}{a.status === "ARCHIVED" ? " · bereits archiviert" : ""}</span></div>
            {a.engagements.length > 0 && <div className="muted text-xs">{a.engagements.slice(0, 8).map((e) => e.title).join(" · ")}{a.engagements.length > 8 ? " …" : ""}</div>}
            <PendingButton busy="Räume auf …" className="btn btn-small">Einsätze entfernen und Kunde archivieren</PendingButton>
          </form>
        ))}
      </section>

      <section className="card space-y-3" id="setups">
        <h2 className="font-semibold">Doppelte Setups ({r.setupDuplicates.length})</h2>
        <p className="muted text-sm">Gleicher Name beim gleichen Kunden (ohne Groß-/Kleinschreibung und Klammerzusätze). Alles am entfernten Setup – Chancen, Einsätze, Mitglieder, Signale, Aktionen – zieht ins behaltene.</p>
        {r.setupDuplicates.map((g) => <SetupMergeForm key={g.keep.id} g={g} />)}
      </section>

      <section className="card space-y-2" id="personen">
        <h2 className="font-semibold">Doppelte Personen ({r.personDuplicates.length})</h2>
        <p className="muted text-sm">Gleicher Name beim gleichen Kunden. Die zuerst angelegte bleibt; Funktionen, Beziehungen, Einschätzungen und Ansprechpartner-Rollen ziehen um, fehlende Kontaktdaten werden ergänzt.</p>
        {r.personDuplicates.map((g) => (
          <form key={g.keepId} action={cleanupMergePersonsAction} className="flex flex-wrap gap-2 items-baseline text-sm" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <input type="hidden" name="keep" value={g.keepId} />
            {g.dropIds.map((d) => <input key={d} type="hidden" name="drop" value={d} />)}
            <span><strong>{g.name}</strong> · {g.accountName} <span className="muted text-xs">{g.dropIds.length + 1}× angelegt{g.emails.length ? ` · ${g.emails.join(", ")}` : ""}</span></span>
            <PendingButton busy="Führe zusammen …" className="btn btn-small ml-auto">Zusammenführen</PendingButton>
          </form>
        ))}
      </section>
    </div>
  );
}
