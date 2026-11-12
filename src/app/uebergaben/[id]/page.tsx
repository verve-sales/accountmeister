import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { markSeen } from "@/modules/notifications/service";
import { DomainError } from "@/lib/errors";
import { getHandover, handoverKindLabel, handoverTask } from "@/modules/conversion/handover";
import { docTypeLabel, signedStatusLabel } from "@/modules/engagements/service";
import { Feedback } from "@/components/Feedback";
import { PendingButton } from "@/components/PendingButton";
import { fmtDate, fmtDateTime } from "@/lib/labels";
import { ackHandoverAction } from "@/app/actions";

export const metadata = { title: "Übergabe ans Backoffice" };

const UNIT: Record<string, string> = { TAG: "je Tag", STUNDE: "je Stunde" };
const CHANNEL: Record<string, string> = { DIREKT: "direkt", VERMITTLER: "über Vermittler", RAHMENVERTRAG: "Rahmenvertrag" };

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <><dt className="muted">{k}</dt><dd>{children}</dd></>;
}

export default async function UebergabePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fehler?: string; ok?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  await markSeen(actor, `/uebergaben/${id}`);
  let v;
  try {
    v = await getHandover(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const { handover: h, payload: p } = v;
  const eur = (x: string | null, unit: string | null) => (x ? `${Number(x).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR ${UNIT[unit ?? ""] ?? ""}` : "offen");
  const needsProject = ["BEAUFTRAGT", "VORLAEUFIG"].includes(h.kind);
  return (
    <div className="space-y-5">
      <p className="text-sm"><Link href="/uebergaben">Übergaben</Link></p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{handoverTask[h.kind] ?? h.kind}</h1>
        <span className="status">{handoverKindLabel[h.kind] ?? h.kind}</span>
        <span className="status" style={h.status === "OFFEN" ? { background: "#fdf2e0", color: "#8a5a00" } : undefined}>{h.status === "QUITTIERT" ? "quittiert" : "offen"}</span>
      </div>
      <Feedback params={sp} />
      <section className="card">
        <dl className="text-sm grid gap-x-6 gap-y-1" style={{ gridTemplateColumns: "max-content 1fr" }}>
          <Row k="Kunde · Setup">{p.kunde} · {p.setup}</Row>
          <Row k="Person">{p.person} <span className="muted">({p.personArt === "FREELANCER" ? "Freelancer" : "intern"})</span> · <Link href={`/einsaetze/${h.engagementId}`}>Einsatz</Link></Row>
          <Row k="Rolle">{p.rolle}</Row>
          <Row k="Laufzeit">{p.beginn ? fmtDate(p.beginn) : "offen"} – {p.ende ? fmtDate(p.ende) : "offen"}</Row>
          <Row k="Bestellnummer">{p.bestellnummer ? <strong>{p.bestellnummer}</strong> : <span style={{ color: "#b7791f" }}>offen – Bestellung folgt</span>}{p.bestellungLink ? <> · <a href={p.bestellungLink} target="_blank" rel="noreferrer">Bestellung</a></> : null}</Row>
          <Row k="Moco-Angebot">{p.angebotsnummer ?? <span className="muted">keines (z. B. Vermittlergeschäft) – Projekt direkt anlegen</span>}{p.angebotLink ? <> · <a href={p.angebotLink} target="_blank" rel="noreferrer">Datei</a></> : null}</Row>
          <Row k="Verkaufssatz">{eur(p.vk, p.vkEinheit)}</Row>
          {p.kontingent && <Row k="Umfang">{p.kontingent}</Row>}
          <Row k="Beschaffungsweg">{CHANNEL[p.beschaffungsweg] ?? p.beschaffungsweg}{p.vermittler ? ` · Rechnung an: ${p.vermittler}` : ""}</Row>
          {p.rechnungshinweis && <Row k="Hinweis zur Rechnung">{p.rechnungshinweis}</Row>}
          {p.personArt === "FREELANCER" && v.showConditions && <Row k="Einkaufssatz">{eur(p.ek, p.ekEinheit)}</Row>}
          {p.personArt === "FREELANCER" && v.showConditions && <Row k="Rechnungsdaten Freelancer">{p.freelancerRechnungsdaten ?? <span className="muted">im Freelancer-Profil noch leer</span>}</Row>}
          {p.hinweis && <Row k="Anmerkung">{p.hinweis}</Row>}
          <Row k="Übergeben von">{v.createdByName} am {fmtDateTime(h.createdAt)}</Row>
        </dl>
        {p.unterlagen.length > 0 && (
          <>
            <h2 className="font-semibold text-sm mt-3 mb-1">Unterlagen am Einsatz</h2>
            <ul className="text-sm space-y-0.5">
              {p.unterlagen.map((u, i) => <li key={i}>{docTypeLabel[u.typ] ?? u.typ}: {u.link ? <a href={u.link} target="_blank" rel="noreferrer">{u.titel}</a> : u.titel} <span className="muted">· {signedStatusLabel[u.status] ?? u.status}</span></li>)}
            </ul>
            <p className="muted text-xs mt-1">Hochgeladene Dateien liegen am <Link href={`/einsaetze/${h.engagementId}#vertraege`}>Einsatz</Link>.</p>
          </>
        )}
      </section>

      {h.status === "QUITTIERT" ? (
        <section className="card text-sm">Quittiert von {v.ackByName} am {h.ackAt ? fmtDateTime(h.ackAt) : "?"}{h.mocoProjectId ? ` · Moco-Projekt ${h.mocoProjectId}` : ""}{h.ackNote ? ` · ${h.ackNote}` : ""}</section>
      ) : v.canAck ? (
        <section className="card space-y-2">
          <h2 className="font-semibold">Quittieren</h2>
          <form action={ackHandoverAction.bind(null, h.id)} className="flex flex-wrap gap-3 items-end text-sm">
            {needsProject && (
              <>
                <label className="space-y-1"><span className="block muted text-xs">Moco-Projekt aus dem Abgleich</span>
                  <select name="mocoProjectId" className="input" defaultValue=""><option value="">– wählen –</option>{v.mocoProjects.map((m) => <option key={m.id} value={m.id}>{m.label} (ID {m.id})</option>)}</select>
                </label>
                <label className="space-y-1"><span className="block muted text-xs">oder Moco-Projekt-ID</span><input name="mocoProjectIdManual" className="input" inputMode="numeric" pattern="\d*" style={{ width: 160 }} /></label>
              </>
            )}
            <label className="space-y-1" style={{ flex: "1 1 260px" }}><span className="block muted text-xs">Anmerkung (optional)</span><input name="note" className="input" /></label>
            <PendingButton busy="Quittiere …">Erledigt – quittieren</PendingButton>
          </form>
          {needsProject && <p className="muted text-xs">Mit dem Moco-Projekt steht die Projektnummer am Einsatz, und der Moco-Abgleich legt keinen zweiten Einsatz an. Neue Projekte erscheinen in der Auswahl nach dem nächsten Abgleich (stündlich); bis dahin die ID aus der Moco-Adresse des Projekts eintragen.</p>}
        </section>
      ) : (
        <section className="card text-sm muted">Wartet auf die Quittung des Backoffice.</section>
      )}
    </div>
  );
}
