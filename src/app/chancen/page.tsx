import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { drilldown, type DrillParams } from "@/modules/opportunities/drilldown";
import { fmtDate } from "@/lib/labels";
import { BOARD_STAGES, boardData } from "@/modules/opportunities/board";
import { PipelineBoard } from "./PipelineBoard";

/** Drill-down hinter den Kennzahlen (Etappe 46): die Chancen bzw. Kunden, aus denen eine Zahl gezählt ist. */
export default async function ChancenPage({ searchParams }: { searchParams: Promise<DrillParams & { ansicht?: string }> }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  // e69 (E4): ohne Filter zeigt die Seite das Board; Kennzahlen-Links (mit Filter) führen weiter auf die Liste
  const filtered = Object.keys(sp).some((k) => k !== "ansicht" && (sp as Record<string, string | undefined>)[k]);
  const board = sp.ansicht === "board" || (!filtered && sp.ansicht !== "liste");
  const switcher = (
    <nav className="flex gap-2" aria-label="Ansicht">
      <Link href="/chancen?ansicht=board" className="chip" aria-current={board ? "page" : undefined}>Board</Link>
      <Link href="/chancen?ansicht=liste" className="chip" aria-current={!board ? "page" : undefined}>Liste</Link>
    </nav>
  );
  if (board) {
    const cards = await boardData(actor);
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold">Chancen</h1>
          <span className="muted text-sm">{cards.filter((c) => c.status !== "BEAUFTRAGT").length} offen</span>
          <span className="ml-auto">{switcher}</span>
        </div>
        <PipelineBoard cards={cards} stages={BOARD_STAGES} />
      </div>
    );
  }
  const r = await drilldown(actor, sp);
  return (
    <div className="space-y-5">
      <nav className="crumbs" aria-label="Pfad"><Link href="/chancen">Pipeline</Link><span>Chancen</span></nav>
      <div className="flex flex-wrap items-baseline gap-3"><h1 className="text-2xl font-semibold">{r.title}</h1><span className="ml-auto">{switcher}</span></div>
      <section className="card">
        {r.mode === "kunden" ? (
          r.accounts.length === 0 ? <p className="empty">Keine Kunden.</p> : (
            <table className="list text-sm">
              <thead><tr><th>Kunde</th><th>BD</th><th style={{ textAlign: "right" }}>offene Chancen</th></tr></thead>
              <tbody>{r.accounts.map((a) => <tr key={a.id}><td><Link href={`/kunden/${a.id}?b=strategie`}>{a.name}</Link></td><td>{a.bdName}</td><td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{a.openChances}</td></tr>)}</tbody>
            </table>
          )
        ) : r.chances.length === 0 ? <p className="empty">Keine Chancen.</p> : (
          <table className="list text-sm">
            <thead><tr><th>Chance</th><th>Kunde · Projekt</th><th>Art</th><th>Stand</th><th>BD</th><th>angelegt</th>{sp.vorgestellt ? <th style={{ textAlign: "right" }}>vorgestellt</th> : null}</tr></thead>
            <tbody>
              {r.chances.map((c) => (
                <tr key={c.id}>
                  <td><Link href={`/bedarfe/${c.id}`}>{c.title}</Link></td>
                  <td><Link href={`/kunden/${c.accountId}?b=strategie`}>{c.accountName}</Link>{c.setupName ? <span className="muted"> · {c.setupName}</span> : null}</td>
                  <td>{c.kind}</td>
                  <td>{c.status}{c.stageLag && <span className="chip" data-tone="warn" title="Einsatz läuft bereits – Stufe auf der Chance nachziehen" style={{ marginLeft: 6 }}>Einsatz läuft</span>}</td>
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
