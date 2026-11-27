import { titleWithoutPerson } from "@/lib/labels";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { asgOverview, asgStateLabel, canUseAssignments } from "@/modules/assignments/service";
import { ASG_COLOR } from "@/components/AsgTimeline";
import { fmtDate } from "@/lib/labels";

const eur = (v: string | null, unit: string) => (v ? `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(Number(v))} €/${unit === "STUNDE" ? "Std." : "Tag"}` : "–");
const contractLabel: Record<string, string> = { UNTERSCHRIEBEN: "unterschrieben", VERSENDET: "versendet", ENTWURF: "Entwurf" };

export default async function KonditionenPage({ searchParams }: { searchParams: Promise<{ q?: string; wer?: string }> }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!(await canUseAssignments(actor))) redirect("/start");
  const o = await asgOverview(actor);
  const q = (sp.q ?? "").trim().toLowerCase();
  const wer = sp.wer === "freelancer" || sp.wer === "intern" ? sp.wer : "alle";
  const rows = o.engagements
    .filter((e) => e.state !== "BEENDET")
    .filter((e) => wer === "alle" || (wer === "freelancer" ? e.kind === "FREELANCER" : e.kind === "INTERN"))
    .filter((e) => !q || [e.person, e.accountName, e.title, e.orderReference ?? "", e.offerNumber ?? ""].some((f) => f.toLowerCase().includes(q)))
    .sort((a, b) => (a.end ?? "9999").localeCompare(b.end ?? "9999"));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <h1 className="text-2xl font-semibold">Laufzeiten &amp; Konditionen</h1>
        <form method="get" className="flex gap-2 items-end ml-auto text-sm">
          <select name="wer" className="select" defaultValue={wer} aria-label="Wer" style={{ width: "9rem" }}><option value="alle">alle</option><option value="freelancer">Freelancer</option><option value="intern">Interne</option></select>
          <input name="q" className="input" defaultValue={sp.q ?? ""} placeholder="Person, Kunde, Bestellnummer …" style={{ width: "16rem" }} />
          <button className="btn btn-secondary btn-small" type="submit">Filtern</button>
        </form>
      </div>
      <section className="card" style={{ overflowX: "auto" }}>
        {rows.length === 0 ? <p className="empty">Keine Einsätze.</p> : (
          <div className="table-wrap"><table className="list text-sm">
            <thead><tr><th>Person</th><th>Kunde · Rolle</th><th>Laufzeit</th><th>Stand</th><th style={{ textAlign: "right" }}>VK</th><th style={{ textAlign: "right" }}>EK</th><th style={{ textAlign: "right" }}>Spanne</th><th>Umfang</th><th>Bestellung</th><th>Angebot</th><th>Vertrag</th><th>Moco</th></tr></thead>
            <tbody>
              {rows.map((e) => {
                const margin = e.vk && e.ek && Number(e.vk) > 0 ? Math.round(((Number(e.vk) - Number(e.ek)) / Number(e.vk)) * 100) : null;
                return (
                  <tr key={e.id}>
                    <td><Link href={`/einsaetze/${e.id}`}><strong>{e.person}</strong></Link>{e.kind === "INTERN" ? <span className="muted text-xs"> intern</span> : null}</td>
                    <td>{e.accountName}<div className="muted text-xs">{titleWithoutPerson(e.title, e.person)}</div></td>
                    <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{e.start ? fmtDate(e.start) : "?"} – {e.end ? fmtDate(e.end) : "offen"}{e.daysToEnd !== null ? <div className="muted text-xs">{e.daysToEnd < 0 ? `seit ${-e.daysToEnd} Tagen vorbei` : `noch ${e.daysToEnd} Tage`}</div> : null}</td>
                    <td style={{ whiteSpace: "nowrap" }}><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: ASG_COLOR[e.state], marginRight: 5 }} />{asgStateLabel[e.state]}{e.renewalTo ? <div className="muted text-xs">bis {fmtDate(e.renewalTo)}</div> : null}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{eur(e.vk, e.rateUnit)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{e.kind === "INTERN" ? <span className="muted">–</span> : eur(e.ek, e.rateUnit)}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{margin !== null ? `${margin} %` : <span className="muted">–</span>}</td>
                    <td className="muted">{e.scope ?? "–"}</td>
                    <td>{e.orderReference ?? <span style={{ color: "#b7791f" }}>fehlt</span>}</td>
                    <td className="muted">{e.offerNumber ?? "–"}</td>
                    <td>{e.kind === "INTERN" ? <span className="muted">entfällt</span> : e.contract ? <span style={{ color: e.contract === "UNTERSCHRIEBEN" ? "#2f7d32" : "#b7791f" }}>{contractLabel[e.contract] ?? e.contract}</span> : <span style={{ color: "var(--danger)" }}>fehlt</span>}</td>
                    <td className="muted">{e.mocoProjectId ?? "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </section>
      <p className="muted text-xs">Einkaufssätze und Spanne sehen nur Sales Operations, Backoffice und Geschäftsführung. Geändert wird am Einsatz (Klick auf den Namen).</p>
    </div>
  );
}
