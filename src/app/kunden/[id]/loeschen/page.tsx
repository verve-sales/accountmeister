import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { previewAccountDeletion } from "@/modules/accounts/deletion";
import { DomainError } from "@/lib/errors";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { archiveAccountAction, deleteAccountAction, restoreAccountAction } from "../../../actions";

/**
 * Kunde löschen – Bestätigungsseite (E-042). Zeigt, was betroffen wäre, und verlangt Archivierung,
 * Namensbestätigung und Begründung, bevor endgültig gelöscht wird.
 */
export default async function KundeLoeschenPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let p;
  try {
    p = await previewAccountDeletion(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const { account } = p;
  return (
    <div className="space-y-6 max-w-3xl">
      <p className="text-sm"><Link href="/kunden">Kunden</Link> › <Link href={`/kunden/${account.id}`}>{account.name}</Link> › Löschen</p>
      <h1 className="text-2xl font-semibold">Kunde „{account.name}“ löschen</h1>
      <Feedback params={sp} />

      <section className="card">
        <h2 className="font-semibold mb-2">Was betroffen ist</h2>
        <p className="text-sm mb-2">Mit dem Kunden werden endgültig entfernt:</p>
        <table className="list text-sm">
          <tbody>
            <tr><td>Setups</td><td>{p.setups.length}{p.setups.length > 0 && <span className="muted"> – {p.setups.map((s) => s.name).join(", ")}</span>}</td></tr>
            <tr><td>Ansprechpartner (mit Beziehungen und Einschätzungen)</td><td>{p.persons}</td></tr>
            <tr><td>Quellen (Notizen, Dokumente samt Dateien, Interview- und Assistentenverläufe)</td><td>{p.sources}</td></tr>
            <tr><td>Hinweise</td><td>{p.signals}</td></tr>
            <tr><td>Bedarfe (mit Angeboten und Aufträgen)</td><td>{p.opportunities}</td></tr>
            <tr><td>Aktionen</td><td>{p.actions}</td></tr>
            <tr><td>Vorschläge</td><td>{p.suggestions}</td></tr>
            <tr><td>Reviews</td><td>{p.reviews}</td></tr>
          </tbody>
        </table>
        <p className="muted text-sm mt-3">Erhalten bleiben: das Prüfprotokoll (mit Name des Kunden, Begründung und Umfang der Löschung), Ziele und KI-Verbrauchsprotokolle – dort wird nur der Kundenbezug gelöst. Anlagevorschläge aus Dokumenten verlieren ihren Verweis auf den Kunden.</p>
      </section>

      {account.status !== "ARCHIVED" ? (
        <section className="card">
          <h2 className="font-semibold mb-2">Schritt 1: Archivieren</h2>
          <p className="text-sm mb-3">Endgültig gelöscht werden nur archivierte Kunden. Archivieren nimmt den Kunden aus den Arbeitslisten; alles bleibt erhalten und lässt sich wiederherstellen.</p>
          <form action={archiveAccountAction}>
            <input type="hidden" name="accountId" value={account.id} />
            <button className="btn" type="submit">Kunde archivieren</button>
          </form>
        </section>
      ) : (
        <>
          <section className="card">
            <h2 className="font-semibold mb-2">Archiviert</h2>
            <p className="text-sm mb-3">Der Kunde ist archiviert. Sie können ihn wiederherstellen oder im nächsten Schritt endgültig löschen.</p>
            <form action={restoreAccountAction}>
              <input type="hidden" name="accountId" value={account.id} />
              <button className="btn btn-secondary" type="submit">Wiederherstellen</button>
            </form>
          </section>
          <section className="card" style={{ borderColor: "#c0392b" }}>
            <h2 className="font-semibold mb-2">Schritt 2: Endgültig löschen</h2>
            <p className="text-sm mb-3">Dieser Schritt lässt sich nicht rückgängig machen. Zur Bestätigung den Kundennamen eintippen und eine Begründung angeben – sie bleibt im Prüfprotokoll.</p>
            <form action={deleteAccountAction} className="grid gap-3">
              <input type="hidden" name="accountId" value={account.id} />
              <div>
                <label className="label" htmlFor="confirmName">Kundenname zur Bestätigung („{account.name}“)</label>
                <input id="confirmName" name="confirmName" className="input" required autoComplete="off" />
              </div>
              <div>
                <label className="label" htmlFor="reason">Begründung (mindestens 10 Zeichen)</label>
                <textarea id="reason" name="reason" className="textarea" required minLength={10} maxLength={1000} placeholder="z. B. Fehlanlage / Testdaten / Löschverlangen des Kunden vom …" />
              </div>
              <div><button className="btn" type="submit" style={{ background: "#c0392b" }}>Kunde mit allen Daten endgültig löschen</button></div>
            </form>
          </section>
        </>
      )}
    </div>
  );
}
