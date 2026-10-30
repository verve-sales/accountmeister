import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { drilldown, type DrillParams } from "@/modules/opportunities/drilldown";
import { fmtDate } from "@/lib/labels";

/** Drill-down hinter den Kennzahlen (Etappe 46): die Chancen bzw. Kunden, aus denen eine Zahl gezählt ist. */
export default async function ChancenPage({ searchParams }: { searchParams: Promise<DrillParams> }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const r = await drilldown(actor, sp);
  return (
    <div className="space-y-5">
      <p className="text-sm"><Link href="/start">Start</Link> › Drill-down</p>
      <h1 className="text-2xl font-semibold">{r.title}</h1>
      <section className="card">
        {r.mode === "kunden" ? (
          r.accounts.length === 0 ? <p className="muted text-sm">Keine Kunden.</p> : (
            <table className="list text-sm">
              <thead><tr><th>Kunde</th><th>BD</th><th style={{ textAlign: "right" }}>offene Chancen</th></tr></thead>
              <tbody>{r.accounts.map((a) => <tr key={a.id}><td><Link href={`/kunden/${a.id}?b=strategie`}>{a.name}</Link></td><td>{a.bdName}</td><td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{a.openChances}</td></tr>)}</tbody>
            </table>
          )
        ) : r.chances.length === 0 ? <p className="muted text-sm">Keine Chancen.</p> : (
          <table className="list text-sm">
            <thead><tr><th>Chance</th><th>Kunde · Setup</th><th>Art</th><th>Stand</th><th>BD</th><th>angelegt</th>{sp.vorgestellt ? <th style={{ textAlign: "right" }}>vorgestellt</th> : null}</tr></thead>
            <tbody>
              {r.chances.map((c) => (
                <tr key={c.id}>
                  <td><Link href={`/bedarfe/${c.id}`}>{c.title}</Link></td>
                  <td><Link href={`/kunden/${c.accountId}?b=strategie`}>{c.accountName}</Link>{c.setupName ? <span className="muted"> · {c.setupName}</span> : null}</td>
                  <td>{c.kind}</td>
                  <td>{c.status}</td>
                  <td>{c.bdName}</td>
                  <td>{fmtDate(c.createdAt)}</td>
                  {sp.vorgestellt ? <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{c.offers}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted text-xs mt-2">{r.mode === "kunden" ? `${r.accounts.length} Kunden` : `${r.chances.length} Chancen`} · dieselben Regeln wie die Zählung, nur Kunden, die du sehen darfst.</p>
      </section>
    </div>
  );
}
