import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { hasRole } from "@/modules/identity/actor";
import { retentionReview } from "@/modules/governance/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { fmtDate } from "@/lib/labels";
import { pseudonymizePersonAction, purgeExpiredLogsAction } from "../../actions";

/**
 * Fristenprüfung (docs/pilotfreigabe-vorschlag.md Abschnitt 6/7, Etappe 18): zeigt, was laut Löschkonzept fällig
 * ist. Nur Datenklassen, deren Frist sich aus einem einzelnen Zeitstempel ohne fachliche Einzelfallprüfung
 * ableiten lässt, werden hier automatisch ermittelt und mit einer Aktion versehen (Ansprechpartner, Protokoll-
 * und KI-Auftragseinträge). Alles mit Ermessensspielraum bleibt eine Sichtprüfung durch die Betriebsverwaltung.
 */
export default async function FristenpruefungPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!hasRole(actor, "ADMIN")) notFound();
  let review;
  try {
    review = await retentionReview(actor);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Fristenprüfung</h1>
      <p className="muted text-sm">
        Was laut Löschkonzept (<Link href="/verwaltung">Verwaltung</Link>, `docs/pilotfreigabe-vorschlag.md` Abschnitt 6) fällig ist. Diese Seite verändert nichts von sich aus – jede Löschung braucht eine bewusste Aktion hier. Datenklassen mit
        Ermessensspielraum (Quellen bei laufendem Auftrag, Bedarfe/Angebote/Aufträge ohne Belegcharakter, vertrauliche Führungsnotizen nach Austritt) sind hier nur als Zahl aufgeführt, nicht automatisch gelöscht.
      </p>
      <Feedback params={sp} />

      <section className="card">
        <h2 className="font-semibold mb-2">Ansprechpartner ohne aktive Beziehung, seit {fmtDate(review.standardCutoff)} ({review.contacts.total})</h2>
        <p className="muted text-sm mb-2">3 Jahre nach der letzten dokumentierten Interaktion, ohne aktiven Beziehungsstand. Löschung pseudonymisiert die Stammdaten (Name, E-Mail, Telefon) – Metadaten und Protokoll bleiben.</p>
        {review.contacts.items.length === 0 ? (
          <p className="muted text-sm">Keine fällig.</p>
        ) : (
          <table className="list text-sm">
            <thead><tr><th>Ansprechpartner</th><th>Letzte Interaktion</th><th></th></tr></thead>
            <tbody>
              {review.contacts.items.map((c) => (
                <tr key={c.personId}>
                  <td>{c.displayName}</td>
                  <td>{fmtDate(c.lastInteraction)}</td>
                  <td>
                    <form action={pseudonymizePersonAction} className="flex gap-2 items-center">
                      <input type="hidden" name="personId" value={c.personId} />
                      <input type="text" name="reason" className="input" placeholder="Anlass (z. B. Fristenprüfung)" required minLength={5} />
                      <button className="btn btn-secondary btn-small" type="submit">Löschen</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {review.contacts.total > review.contacts.items.length && <p className="muted text-xs mt-1">Weitere {review.contacts.total - review.contacts.items.length} nicht angezeigt (erste 50).</p>}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Quellen ohne Aktivität seit {fmtDate(review.standardCutoff)} ({review.sources.total})</h2>
        <p className="muted text-sm mb-2">3 Jahre nach der Quellenzeit, noch nicht gesperrt/entfernt. Vorsicht: Bei laufendem Auftrag gilt die Frist erst 3 Jahre nach Auftragsende – das prüft diese Liste nicht automatisch. Löschung erfolgt wie gewohnt auf der Quellenseite (Sperren → Inhalt entfernen).</p>
        {review.sources.items.length === 0 ? (
          <p className="muted text-sm">Keine fällig.</p>
        ) : (
          <table className="list text-sm">
            <thead><tr><th>Quelle</th><th>Zeitpunkt</th><th></th></tr></thead>
            <tbody>
              {review.sources.items.map((s) => (
                <tr key={s.id}>
                  <td>{s.title}</td>
                  <td>{fmtDate(s.time)}</td>
                  <td><Link href={`/quellen/${s.id}`} className="btn btn-secondary btn-small">Öffnen</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {review.sources.total > review.sources.items.length && <p className="muted text-xs mt-1">Weitere {review.sources.total - review.sources.items.length} nicht angezeigt (erste 50).</p>}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Protokoll- und KI-Auftragseinträge</h2>
        <table className="list text-sm">
          <tbody>
            <tr><td>Audit-Protokoll älter als {fmtDate(review.standardCutoff)} (3 Jahre)</td><td>{review.auditEvents.total} Einträge</td></tr>
            <tr><td>KI-Auftragsprotokolle älter als {fmtDate(review.aiJobsCutoff)} (1 Jahr)</td><td>{review.aiJobs.total} Einträge</td></tr>
          </tbody>
        </table>
        <p className="muted text-sm mt-2">Diese Protokolle enthalten keine Rohinhalte (nur Feldnamen bzw. Hash/Länge) – die Löschung dient allein der Frist, nicht dem Schutz vor Inhaltszugriff. Was ein Protokolleintrag erzeugt hat (z. B. ein Vorschlag oder eine Berater-Fassung), bleibt erhalten; nur der Verweis auf den Auftrag entfällt.</p>
        {(review.auditEvents.total > 0 || review.aiJobs.total > 0) && (
          <form action={purgeExpiredLogsAction} className="mt-2">
            <button className="btn btn-secondary" type="submit">Fällige Protokolleinträge jetzt löschen</button>
          </form>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Bedarfe/Angebote/Aufträge mit Belegcharakter, älter als {fmtDate(review.belegeCutoff)} (10 Jahre)</h2>
        <p className="muted text-sm mb-2">Ab dieser Marke ist die längste vertretbare Aufbewahrung (handels-/steuerrechtlich) in jeder Lesart abgelaufen. Löschung ist hier nicht automatisiert – bitte fachlich prüfen und über die jeweilige Chance/den jeweiligen Auftrag entscheiden.</p>
        <table className="list text-sm">
          <tbody>
            <tr><td>Angebote</td><td>{review.belege.offers}</td></tr>
            <tr><td>Aufträge</td><td>{review.belege.orders}</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Weiterhin manuell zu prüfen</h2>
        <p className="muted text-sm">Vertrauliche Führungsnotizen und Zielgespräche (Dauer des Beschäftigungsverhältnisses + 1 Jahr) – die Anwendung kennt kein Austrittsdatum. Weeklys, Aktionen, Übergaben und Accountpläne (3 Jahre) – noch keine Sichtprüfung hinterlegt. Zugänge ausgeschiedener Beschäftigter (Pseudonymisierung des Namens nach 3 Jahren) – Deaktivierung erfolgt unter Verwaltung, die Pseudonymisierung folgt noch von Hand.</p>
      </section>
    </div>
  );
}
