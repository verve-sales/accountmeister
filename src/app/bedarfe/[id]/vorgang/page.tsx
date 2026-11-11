import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { getConfig } from "@/lib/config";
import { DomainError } from "@/lib/errors";
import { getConversion, offerPathLabel, type Step } from "@/modules/conversion/service";
import { handoverKindLabel } from "@/modules/conversion/handover";
import { signedStatusLabel } from "@/modules/engagements/service";
import { Feedback } from "@/components/Feedback";
import { PendingButton } from "@/components/PendingButton";
import { fmtDate, fmtDateTime } from "@/lib/labels";
import { conversionStepAction, startConversionAction } from "@/app/actions";

export const metadata = { title: "Konvertierungsvorgang" };

const GREEN = "#2f7d32";
const AMBER = "#b7791f";
const STATE_LABEL: Record<string, string> = { ERLEDIGT: "erledigt", AKTUELL: "jetzt dran", OFFEN: "offen", ENTFAELLT: "entfällt" };
const CONV_STATUS: Record<string, string> = { LAUFEND: "läuft", RUHEND: "ruht (Chance zurückgestellt)", ABGEBROCHEN: "abgebrochen", ABGESCHLOSSEN: "abgeschlossen" };
const CHANNEL: Record<string, string> = { DIREKT: "direkt", VERMITTLER: "über Vermittler", RAHMENVERTRAG: "Rahmenvertrag" };

function StepHead({ s }: { s: Step }) {
  const color = s.state === "ERLEDIGT" ? GREEN : s.state === "AKTUELL" ? "var(--accent, #1f4e79)" : "var(--border)";
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span aria-hidden style={{ display: "inline-flex", width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center", border: `2px solid ${color}`, color: s.state === "ERLEDIGT" ? "#fff" : undefined, background: s.state === "ERLEDIGT" ? GREEN : "transparent", fontWeight: 600, fontSize: 13 }}>{s.state === "ERLEDIGT" ? "✓" : s.no}</span>
      <h2 className="font-semibold" style={{ opacity: s.state === "ENTFAELLT" ? 0.55 : 1 }}>{s.title}</h2>
      <span className="status" style={s.state === "AKTUELL" ? { background: "#e8f0f8", color: "#1f4e79" } : undefined}>{STATE_LABEL[s.state]}</span>
      <span className="muted text-sm">{s.note}</span>
    </div>
  );
}

export default async function VorgangPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fehler?: string; ok?: string }> }) {
  if (getConfig().FEATURE_BESETZUNG !== "true") notFound();
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let v;
  try {
    v = await getConversion(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  if (!v) {
    return (
      <div className="space-y-5">
        <p className="text-sm"><Link href={`/bedarfe/${id}`}>← zur Chance</Link></p>
        <h1 className="text-2xl font-semibold">Konvertierungsvorgang</h1>
        <Feedback params={sp} />
        <section className="card space-y-2">
          <p className="text-sm">Der Vorgang führt die Chance in sechs Schritten bis zur Beauftragung: Anfrage, Klärung, Besetzung, Angebot, Freelancer-Vertrag, Beauftragung mit Übergabe ans Backoffice.</p>
          <form action={startConversionAction.bind(null, id)}><PendingButton busy="Starte …">Vorgang starten</PendingButton></form>
        </section>
      </div>
    );
  }
  const c = v.conversion;
  const step = (k: Step["key"]) => v.steps.find((s) => s.key === k)!;
  const act = conversionStepAction.bind(null, id, c.id);
  const noOffer = v.offerPath === "KEIN_ANGEBOT";
  const freelancerPositions = v.positions.filter((p) => p.resourceKind === "FREELANCER");
  return (
    <div className="space-y-5">
      <p className="text-sm"><Link href="/kunden">Kunden</Link> › {v.accountName} › {v.setupName} › <Link href={`/bedarfe/${id}`}>{v.opportunity.title}</Link></p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Konvertierungsvorgang</h1>
        <span className="status">{CONV_STATUS[c.status] ?? c.status}</span>
        <span className="muted text-sm">Beschaffungsweg: {CHANNEL[v.channel] ?? v.channel} · Angebotsweg: {offerPathLabel[v.offerPath]} · <Link href={`/setups/${v.opportunity.setupId}#angebotsweg`}>ändern</Link></span>
      </div>
      <Feedback params={sp} />
      {c.status === "ABGEBROCHEN" && <p className="text-sm" style={{ color: AMBER }}>Abgebrochen{c.endedReason ? `: ${c.endedReason}` : ""}. Alle Angaben und Unterlagen bleiben einsehbar.</p>}

      {v.intermediaryCheckOpen && (
        <section className="card space-y-2" style={{ borderLeft: `3px solid ${AMBER}` }}>
          <h2 className="font-semibold">Prüfhinweis: Freelancer über Vermittler</h2>
          <p className="text-sm">Der Kunde läuft über einen Vermittler und mindestens eine Position ist mit einem Freelancer vorgesehen. Bei offenen Ausschreibungen eines Vermittlers bieten wir keine Freelancer an – dann die Chance schließen. Ist der Vermittler nur Rahmenvertragspartner, der unsere Bestellung durchreicht, kurz festhalten, warum ein Freelancer zulässig ist.</p>
          {v.canEdit && (
            <form action={act} className="flex flex-wrap gap-2 items-end text-sm">
              <input type="hidden" name="op" value="intermediary" /><input type="hidden" name="step" value="3" />
              <label className="space-y-1" style={{ flex: "1 1 320px" }}><span className="block muted text-xs">Begründung (z. B. Rahmenvertragspartner, Vertragsklausel)</span><input name="note" className="input" required minLength={5} /></label>
              <PendingButton busy="Speichere …" className="btn btn-small">Freelancer ist hier zulässig</PendingButton>
            </form>
          )}
        </section>
      )}

      <section className="card space-y-2" id="schritt-1"><StepHead s={step("ANFRAGE")} /></section>

      <section className="card space-y-2" id="schritt-2">
        <StepHead s={step("KLAERUNG")} />
        {step("KLAERUNG").state !== "ERLEDIGT" && v.canEdit && (
          <form action={act} className="text-sm">
            <input type="hidden" name="op" value="clarify" /><input type="hidden" name="step" value="2" />
            <p className="muted mb-2">Anforderung steht an der <Link href={`/bedarfe/${id}#chance`}>Chance</Link>; fehlende Pflichtunterlagen (NDA, Rahmenvertrag) zeigt das Beschaffungsprofil des Kunden.</p>
            <PendingButton busy="Speichere …" className="btn btn-small">Anforderung ist klar</PendingButton>
          </form>
        )}
      </section>

      <section className="card space-y-2" id="schritt-3">
        <StepHead s={step("BESETZUNG")} />
        {v.positions.length === 0 ? <p className="text-sm">Positionen legst du an der <Link href={`/bedarfe/${id}#besetzung`}>Chance</Link> an – intern oder mit Freelancer. Steht die Person fest, genügt die Schnellbesetzung.</p> : (
          <table className="list text-sm">
            <thead><tr><th>Position</th><th>Art</th><th>Besetzt mit</th><th>Stand</th></tr></thead>
            <tbody>
              {v.positions.map((p) => (
                <tr key={p.id}>
                  <td><Link href={`/besetzung/${p.id}`}>{p.title}</Link></td>
                  <td>{p.resourceKind === "FREELANCER" ? "Freelancer" : "intern"}</td>
                  <td>{p.personName ? (p.freelancerId ? <Link href={`/besetzung/freelancer/${p.freelancerId}#profil`}>{p.personName}</Link> : p.personName) : <span className="muted">offen</span>}</td>
                  <td>{p.engagementId ? <Link href={`/einsaetze/${p.engagementId}`}>Einsatz</Link> : <span style={{ color: AMBER }}>noch nicht besetzt</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card space-y-2" id="schritt-4">
        <StepHead s={step("ANGEBOT")} />
        <p className="text-sm">
          {noOffer ? "Kein Angebot: Profil und Konditionen gehen per Mail an den Vermittler." : <>Moco-Angebotsnummer: {c.offerNumber ? <strong>{c.offerNumber}</strong> : <span style={{ color: AMBER }}>offen</span>} · Fassung {c.offerVersion}{c.offerLink ? <> · <a href={c.offerLink} target="_blank" rel="noreferrer">Datei</a></> : null}</>}
          {c.offerSentAt ? <> · abgegeben am {fmtDate(c.offerSentAt)}</> : null}
          {c.commitAt ? <> · Zusage am {fmtDate(c.commitAt)}</> : null}
        </p>
        {v.offerPath === "MOCO_KUNDENVORLAGE" && <p className="muted text-xs">Bei Kundenvorlage bleibt das Moco-Angebot intern; an den Kunden geht nur die ausgefüllte Vorlage mit der Moco-Nummer.</p>}
        {c.commitNote && <p className="muted text-xs" style={{ whiteSpace: "pre-wrap" }}>Zusage: {c.commitNote}</p>}
        {v.canEdit && (
          <div className="space-y-3">
            <form action={act} className="flex flex-wrap gap-2 items-end text-sm">
              <input type="hidden" name="op" value="offer" /><input type="hidden" name="step" value="4" />
              {!noOffer && <label className="space-y-1"><span className="block muted text-xs">Moco-Angebotsnummer</span><input name="offerNumber" className="input" defaultValue={c.offerNumber ?? ""} placeholder="aus Moco" /></label>}
              <label className="space-y-1" style={{ flex: "1 1 260px" }}><span className="block muted text-xs">Link zur Datei (SharePoint, optional)</span><input name="offerLink" className="input" defaultValue={c.offerLink ?? ""} /></label>
              {!c.offerSentAt && <label className="flex gap-1 items-center"><input type="checkbox" name="sent" value="1" /> {noOffer ? "Konditionen sind raus" : "ist abgegeben"}</label>}
              {c.offerSentAt && !noOffer && <label className="flex gap-1 items-center"><input type="checkbox" name="newVersion" value="1" /> neue Fassung (Nachverhandlung, andere Besetzung)</label>}
              <PendingButton busy="Speichere …" className="btn btn-small">Speichern</PendingButton>
            </form>
            {c.offerSentAt && !c.commitAt && (
              <form action={act} className="flex flex-wrap gap-2 items-end text-sm">
                <input type="hidden" name="op" value="commit" /><input type="hidden" name="step" value="4" />
                <label className="space-y-1" style={{ flex: "1 1 360px" }}><span className="block muted text-xs">Zusage des Kunden: wer, wann, was (Satz, Start, Umfang)</span><input name="note" className="input" required minLength={5} /></label>
                <PendingButton busy="Speichere …" className="btn btn-small">Kunde hat zugesagt</PendingButton>
              </form>
            )}
          </div>
        )}
      </section>

      <section className="card space-y-2" id="schritt-5">
        <StepHead s={step("VERTRAG")} />
        {freelancerPositions.length > 0 && (
          <>
            <table className="list text-sm">
              <thead><tr><th>Freelancer</th><th>Vertrag</th><th></th></tr></thead>
              <tbody>
                {freelancerPositions.map((p) => (
                  <tr key={p.id}>
                    <td>{p.personName ?? <span className="muted">noch nicht besetzt</span>}</td>
                    <td>{p.contractStatus ? signedStatusLabel[p.contractStatus] ?? p.contractStatus : <span style={{ color: c.commitAt ? AMBER : undefined }} className={c.commitAt ? "" : "muted"}>noch nicht erzeugt</span>}</td>
                    <td>{p.engagementId ? <Link href={`/einsaetze/${p.engagementId}#vertrag-erzeugen`}>{p.contractStatus ? "Unterlagen am Einsatz" : "Vertrag erzeugen"}</Link> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted text-xs">Der Vertrag entsteht am Einsatz aus der Vorlage und steht unter dem Vorbehalt, dass der Endkunde beauftragt. Mit „versendet“ geht der Vorgang weiter; die Unterschrift wird am Einsatz nachgehalten.</p>
          </>
        )}
      </section>

      <section className="card space-y-2" id="schritt-6">
        <StepHead s={step("BEAUFTRAGUNG")} />
        <p className="text-sm">Bestellnummer: {c.orderReference ? <strong>{c.orderReference}</strong> : <span style={{ color: c.provisionalStart ? AMBER : undefined }}>{c.provisionalStart ? "Bestellung offen (Start mit Zusage per Mail)" : "offen"}</span>}{c.orderLink ? <> · <a href={c.orderLink} target="_blank" rel="noreferrer">Bestellung</a></> : null}</p>
        {v.handovers.length > 0 && (
          <ul className="text-sm space-y-1">
            {v.handovers.map((h) => <li key={h.id}><Link href={`/uebergaben/${h.id}`}>Übergabe „{handoverKindLabel[h.kind] ?? h.kind}“</Link> <span className="muted">vom {fmtDateTime(h.createdAt)}</span> · {h.status === "QUITTIERT" ? <span style={{ color: GREEN }}>quittiert</span> : <span style={{ color: AMBER }}>wartet auf das Backoffice</span>}</li>)}
          </ul>
        )}
        {v.canEdit && !(c.orderAt && c.orderReference) && (
          <form action={act} className="flex flex-wrap gap-2 items-end text-sm">
            <input type="hidden" name="op" value="order" /><input type="hidden" name="step" value="6" />
            <label className="space-y-1"><span className="block muted text-xs">Bestellnummer</span><input name="orderReference" className="input" /></label>
            <label className="space-y-1" style={{ flex: "1 1 240px" }}><span className="block muted text-xs">Link zur Bestellung (SharePoint, optional)</span><input name="orderLink" className="input" defaultValue={c.orderLink ?? ""} /></label>
            {!c.provisionalStart && (
              <details style={{ flexBasis: "100%" }}>
                <summary className="cursor-pointer">Start mit Zusage per Mail, Bestellung kommt später</summary>
                <div className="flex flex-wrap gap-2 items-end mt-2">
                  <label className="flex gap-1 items-center"><input type="checkbox" name="provisional" value="1" /> ja, mit dem Kunden so vereinbart</label>
                  <label className="space-y-1" style={{ flex: "1 1 360px" }}><span className="block muted text-xs">Zusage-Mail: von wem, wann, was</span><input name="evidence" className="input" /></label>
                </div>
              </details>
            )}
            <PendingButton busy="Übergebe …" className="btn btn-small">{c.provisionalStart ? "Bestellnummer nachreichen" : "Beauftragung festhalten und ans Backoffice übergeben"}</PendingButton>
          </form>
        )}
      </section>

      {v.canEdit && (
        <details className="card">
          <summary className="text-sm cursor-pointer">Vorgang abbrechen</summary>
          <form action={act} className="flex flex-wrap gap-2 items-end text-sm mt-2">
            <input type="hidden" name="op" value="cancel" /><input type="hidden" name="step" value="1" />
            <label className="space-y-1" style={{ flex: "1 1 320px" }}><span className="block muted text-xs">Grund</span><input name="reason" className="input" required minLength={3} /></label>
            <button className="btn btn-small btn-secondary" type="submit">Abbrechen</button>
          </form>
          <p className="muted text-xs mt-1">Die Chance bleibt, wie sie ist. Wird die Chance geschlossen, endet der Vorgang von selbst.</p>
        </details>
      )}
    </div>
  );
}
