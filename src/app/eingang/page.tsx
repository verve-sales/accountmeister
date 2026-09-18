import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { listSetupsWithOpenAssignment } from "@/modules/setups/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { fmtDate } from "@/lib/labels";

export default async function EingangPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const open = await listSetupsWithOpenAssignment(actor);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Eingang</h1>
      <Feedback params={params} />
      <section className="card">
        <h2 className="font-semibold mb-2">Setups mit offener BD-Zuordnung ({open.length})</h2>
        {open.length === 0 ? (
          <p className="muted text-sm">Keine offenen Zuordnungen in Ihrem Berechtigungsbereich.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Setup</th><th>Kunde</th><th>Angelegt</th></tr></thead>
            <tbody>
              {open.map(({ setup, account }) => (
                <tr key={setup.id}>
                  <td><Link href={`/setups/${setup.id}`}>{setup.name}</Link></td>
                  <td><Link href={`/kunden/${account.id}`}>{account.name}</Link></td>
                  <td>{fmtDate(setup.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted text-sm mt-3">Die Zuordnung erfolgt über eine Übergabe des Setups an einen BD (im Setup unter „Übergabe“); erst die Annahme setzt die Zuständigkeit.</p>
      </section>
      <section className="card">
        <h2 className="font-semibold mb-1">Neue Quellen und zu prüfende Ergänzungen</h2>
        <p className="muted text-sm">Import von Protokollen sowie Mail-/Kalenderanbindung sind für Etappe 3 vorgesehen und noch nicht umgesetzt.</p>
      </section>
    </div>
  );
}
