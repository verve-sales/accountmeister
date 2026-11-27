import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { Feedback } from "@/components/Feedback";
import { Icon } from "@/components/Icon";
import { canUseOrderIntake, caseChoices, caseStatusLabel, channelLabel, listCases } from "@/modules/o2o/service";
import { isoDe } from "@/lib/labels";
import { offerWithoutDocumentAction, uploadOrderCaseAction } from "../actions";
import { SystemDots } from "./SystemDots";

/**
 * Auftragseingang (e67): Angebot oder Bestellung hochladen – daraus entstehen Chance, Angebot, Auftrag und Einsatz.
 * Darunter die offenen Vorgänge mit dem, was noch fehlt, und dem Stand je System.
 */
export default async function AuftragseingangPage({ searchParams }: { searchParams: Promise<{ fehler?: string; ok?: string; ansicht?: string }> }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!(await canUseOrderIntake(actor))) notFound();
  const filter = sp.ansicht === "alle" ? "alle" : "offen";
  const [cases, choices] = await Promise.all([listCases(actor, filter), caseChoices(actor)]);
  const brokers = choices.accounts.filter((a) => a.broker);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Angebot &amp; Bestellung</h1>
        <p className="muted text-sm mt-1">Ein Upload für alles: Die App liest Nummer, Kunde, Person, Zeitraum und Satz vor; du bestätigst, dann stehen Chance, Einsatz und Unterlagen.</p>
      </div>
      <Feedback params={sp} />

      <section className="card upload-card">
        <form action={uploadOrderCaseAction} encType="multipart/form-data" className="upload-drop">
          <Icon name="file" size={26} />
          <div className="grow">
            <label htmlFor="o2o-file" className="font-semibold">Angebot oder Bestellung hochladen</label>
            <p className="muted text-sm">PDF, Word, Excel, Text oder Mail (.eml) – die Dokumentart wird erkannt.</p>
            <input id="o2o-file" name="file" type="file" required accept=".pdf,.docx,.xlsx,.txt,.md,.eml,.csv" className="input mt-2" />
          </div>
          <button className="btn" type="submit">Hochladen und auslesen</button>
        </form>
        <details className="mt-4" id="ohne-dokument">
          <summary className="font-medium">Angebot ohne Dokument erfassen <span className="muted text-sm font-normal">– mündlich oder per kurzer Mail beim Vermittler</span></summary>
          <form action={offerWithoutDocumentAction} className="grid sm:grid-cols-3 gap-3 mt-3">
            <input type="hidden" name="channel" value="VERMITTLER" />
            <div>
              <label className="label" htmlFor="ow-partner">Vermittler</label>
              <select id="ow-partner" name="partnerAccountId" className="input" defaultValue="">
                <option value="">– neu eintragen –</option>
                {brokers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <input name="partnerNewName" className="input mt-1" placeholder="oder neuer Vermittler" aria-label="Neuer Vermittler" />
            </div>
            <div>
              <label className="label" htmlFor="ow-person">Person</label>
              <select id="ow-person" name="freelancerId" className="input" defaultValue="">
                <option value="">– neu eintragen –</option>
                {choices.freelancers.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <input type="hidden" name="personKind" value="FREELANCER" />
              <input name="personNewName" className="input mt-1" placeholder="oder Name" aria-label="Name der Person" />
            </div>
            <div><label className="label" htmlFor="ow-role">Rolle</label><input id="ow-role" name="role" className="input" required placeholder="z. B. Testmanager" /></div>
            <div><label className="label" htmlFor="ow-rate">Tagessatz (€)</label><input id="ow-rate" name="dailyRate" className="input" inputMode="decimal" /></div>
            <div><label className="label" htmlFor="ow-start">Start</label><input id="ow-start" name="startDate" type="date" className="input" /></div>
            <div><label className="label" htmlFor="ow-end">Ende</label><input id="ow-end" name="endDate" type="date" className="input" /></div>
            <div><label className="label" htmlFor="ow-ref">Referenz des Vermittlers</label><input id="ow-ref" name="brokerRef" className="input" placeholder="z. B. Projektnummer" /></div>
            <div><label className="label" htmlFor="ow-hint">Endkunde (falls bekannt)</label><input id="ow-hint" name="endCustomerHint" className="input" placeholder="auch „Versicherer, Köln“" /></div>
            <div><label className="label" htmlFor="ow-bd">Verantwortlicher BD</label><select id="ow-bd" name="bdUserId" className="input" defaultValue=""><option value="">– wie beim Vermittler –</option>{choices.bds.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
            <div className="flex items-end sm:col-span-2"><button className="btn" type="submit">Angebot erfassen</button></div>
          </form>
        </details>
      </section>

      <section className="card">
        <div className="flex flex-wrap items-baseline gap-3 mb-2">
          <h2 className="font-semibold">Vorgänge ({cases.length})</h2>
          <nav className="flex gap-2 ml-auto" aria-label="Ansicht">
            <Link href="/auftragseingang" className="chip" aria-current={filter === "offen" ? "page" : undefined}>offen</Link>
            <Link href="/auftragseingang?ansicht=alle" className="chip" aria-current={filter === "alle" ? "page" : undefined}>alle</Link>
          </nav>
        </div>
        {cases.length === 0 ? (
          <p className="empty">{filter === "offen" ? "Nichts offen – jedes Angebot und jede Bestellung ist vollständig verarbeitet." : "Noch keine Vorgänge. Lade oben das erste Angebot oder die erste Bestellung hoch."}</p>
        ) : (
          <table className="list text-sm">
            <thead><tr><th>Vorgang</th><th>Stand</th><th>Vertragspartner · Endkunde</th><th>Person · Rolle</th><th>Zeitraum</th><th>Nummern</th><th>Fehlt</th><th>Systeme</th></tr></thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id}>
                  <td><Link href={`/auftragseingang/${c.id}`}><strong>{c.number}</strong></Link><div className="muted text-xs">{channelLabel[c.channel]}{c.isRenewal ? " · Verlängerung" : ""}</div></td>
                  <td><span className="status" data-tone={c.status === "ENTWURF" ? "warn" : c.status === "BEAUFTRAGT" ? "ok" : undefined}>{caseStatusLabel[c.status] ?? c.status}</span></td>
                  <td>{c.partnerName ?? "–"}{c.channel === "VERMITTLER" && <div className="muted text-xs">→ {c.endCustomerName ?? c.endCustomerHint ?? "Endkunde offen"}</div>}</td>
                  <td>{c.personName ?? "–"}<div className="muted text-xs">{c.role ?? ""}</div></td>
                  <td style={{ whiteSpace: "nowrap" }}>{c.startDate ? isoDe(c.startDate) : "?"} – {c.endDate ? isoDe(c.endDate) : "?"}</td>
                  <td className="text-xs">{[c.offerNumber && `Angebot ${c.offerNumber}`, c.brokerRef && `Ref. ${c.brokerRef}`, c.orderNumber && `Bestellung ${c.orderNumber}`].filter(Boolean).join(" · ") || "–"}</td>
                  <td>{c.open.length ? c.open.map((o) => <span key={o} className="chip" data-tone="warn" style={{ marginRight: 4 }}>{o}</span>) : <span className="muted">–</span>}</td>
                  <td><SystemDots c={c} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
