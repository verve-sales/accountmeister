import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getCurrentActor } from "@/modules/identity/session";
import { getConfig } from "@/lib/config";
import { canUseSalesOps, captureChoices, salesOpsOverview } from "@/modules/salesops/service";
import { canClean, cleanupCount } from "@/modules/cleanup/service";
import { canManageSharePoint } from "@/modules/sharepoint/service";
import { approachLabel, approachValues } from "@/modules/engagements/contacts";
import { renewalStatusLabel } from "@/modules/engagements/care";
import { RenewalCards } from "@/components/Renewal";
import { Feedback } from "@/components/Feedback";
import { PendingButton } from "@/components/PendingButton";
import { fmtDate } from "@/lib/labels";
import { captureAssignmentAction } from "@/app/actions";

export const metadata = { title: "Sales-Ops-Sicht" };

const AMBER = "#b7791f";

function Kpi({ n, label, href, warn }: { n: number; label: string; href: string; warn?: boolean }) {
  return (
    <Link href={href} className="card block" style={{ minWidth: 150, textDecoration: "none" }}>
      <div className="text-2xl font-semibold" style={{ color: warn && n > 0 ? AMBER : undefined, fontVariantNumeric: "tabular-nums" }}>{n}</div>
      <div className="muted text-xs">{label}</div>
    </Link>
  );
}

export default async function VertragsbueroPage({ searchParams }: { searchParams: Promise<{ fehler?: string; ok?: string; setup?: string }> }) {
  if (getConfig().FEATURE_BESETZUNG !== "true") notFound();
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!canUseSalesOps(actor)) notFound();
  const [o, choices, cleanN] = await Promise.all([salesOpsOverview(actor), captureChoices(actor), canClean(actor) ? cleanupCount(actor) : Promise.resolve(0)]);
  const chosen = choices.setups.find((s) => s.id === sp.setup) ?? null;
  const persons = chosen ? await db.query.persons.findMany({ where: eq(schema.persons.accountId, chosen.accountId), columns: { id: true, displayName: true }, orderBy: (p, { asc }) => [asc(p.displayName)] }) : [];
  const k = o.kpis;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Sales-Ops-Sicht</h1>
        <span className="muted text-sm">Verlängerungen anstoßen, Ansprechpartner und Unterlagen pflegen, neue Assignments erfassen.</span>
        {canManageSharePoint(actor) && <Link href="/verwaltung/sharepoint" className="text-sm ml-auto">SharePoint-Ablage</Link>}
        <a href="#erfassen" className={`btn btn-small${canManageSharePoint(actor) ? "" : " ml-auto"}`}>Neues Assignment erfassen</a>
      </div>
      <Feedback params={sp} />

      <div className="flex flex-wrap gap-3">
        <Kpi n={k.anzustossen} label="Verlängerung anzustoßen" href="#anstossen" warn />
        <Kpi n={k.ohneAnsprechpartner} label="ohne Verlängerungs-Ansprechpartner" href="/einsaetze?f=ohne_ansprechpartner" warn />
        <Kpi n={k.unterlagenOffen} label="Unterlagen offen" href="/einsaetze?f=vertrag_offen" warn />
        <Kpi n={k.endeUeberschritten} label="Ende überschritten" href={canClean(actor) ? "/bereinigung#ende" : "/einsaetze?f=ende_ueberschritten"} warn />
        <Kpi n={k.uebergabenOffen} label="Übergaben ans Backoffice offen" href="/uebergaben" warn />
        <Kpi n={k.vorgaenge} label="laufende Konvertierungsvorgänge" href="#vorgaenge" />
        <Kpi n={k.mocoHinweise} label="Moco-Hinweise offen" href="/moco" warn />
        {canClean(actor) && <Kpi n={cleanN} label="in der Bereinigung" href="/bereinigung" warn />}
        <Kpi n={k.laufend} label="laufende Einsätze" href="/einsaetze" />
      </div>

      <section className="card space-y-2" id="vorgaenge">
        <h2 className="font-semibold">Laufende Konvertierungsvorgänge ({o.vorgaenge.length})</h2>
        {o.vorgaenge.length === 0 ? <p className="muted text-sm">Kein laufender Vorgang. Gestartet wird er an der Chance.</p> : (
          <table className="list text-sm">
            <thead><tr><th>Position · Chance · Kunde</th><th>Jetzt dran</th><th>Was fehlt</th></tr></thead>
            <tbody>
              {o.vorgaenge.map((x) => (
                <tr key={x.id}>
                  <td><Link href={`/bedarfe/${x.opportunityId}/vorgang?v=${x.id}`}><strong>{x.label}</strong></Link><div className="muted text-xs">{x.title} · {x.accountName}</div></td>
                  <td>{x.step}</td>
                  <td className="text-xs">{x.stepNote}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card space-y-2" id="enden">
        <h2 className="font-semibold">Enden in den nächsten 8 Wochen ({o.ending.length})</h2>
        {o.ending.length === 0 ? <p className="muted text-sm">Keine Einsätze mit Ende in den nächsten 8 Wochen.</p> : (
          <table className="list text-sm">
            <thead><tr><th>Person · Kunde</th><th>Ende</th><th>Verlängerung</th><th>läuft über</th><th>Unterlagen</th></tr></thead>
            <tbody>
              {o.ending.map((e) => (
                <tr key={e.id}>
                  <td><Link href={`/einsaetze/${e.id}`}><strong>{e.personName}</strong></Link><div className="muted text-xs">{e.accountName} · BD {e.bdName}</div></td>
                  <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{e.endDate ? fmtDate(e.endDate) : "offen"}<div className="muted text-xs">{e.daysToEnd !== null ? `${e.daysToEnd} Tage` : ""}</div></td>
                  <td className="text-xs">{e.renewalStatus ? renewalStatusLabel[e.renewalStatus] ?? e.renewalStatus : <span style={{ color: AMBER }}>nicht angestoßen</span>}<div><Link href={`/einsaetze/${e.id}#verlaengerung`}>{e.renewalStatus ? "ansehen" : "anstoßen"}</Link></div></td>
                  <td className="text-xs">
                    {e.contacts.renewal ? <>{e.contacts.renewal.name}{e.contacts.renewal.email ? <div><a href={`mailto:${e.contacts.renewal.email}`}>{e.contacts.renewal.email}</a></div> : null}</> : <Link href={`/einsaetze/${e.id}#ansprechpartner`} style={{ color: AMBER }}>hinterlegen</Link>}
                    {e.contacts.order && e.contacts.order.id !== e.contacts.renewal?.id ? <div className="muted">Bestellung: {e.contacts.order.name}</div> : null}
                    {e.contacts.approach ? <div className="muted">spricht an: {approachLabel[e.contacts.approach]}</div> : null}
                  </td>
                  <td className="text-xs">{e.procurement.complete === true ? "vollständig" : e.procurementException ? "Ausnahme" : e.procurement.complete === false ? <Link href={`/einsaetze/${e.id}#vertraege`} style={{ color: AMBER }}>{e.procurement.required.filter((r) => r.ok).length}/{e.procurement.required.length} – hinterlegen</Link> : <Link href={`/einsaetze/${e.id}#vertraege`} className="muted">hinterlegen</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card space-y-2" id="anstossen">
        <h2 className="font-semibold">Verlängerung anzustoßen ({o.renewalCards.length})</h2>
        {o.renewalCards.length === 0 ? <p className="muted text-sm">Nichts anzustoßen.</p> : <RenewalCards cards={o.renewalCards} back="/vertragsbuero#anstossen" />}
      </section>

      <section className="card space-y-3" id="erfassen">
        <h2 className="font-semibold">Neues Assignment erfassen</h2>
        <p className="muted text-sm">Legt Chance (beauftragt), Auftrag/Bestellung und Einsatzakte in einem Schritt an. Danach öffnet sich der Einsatz, um Vertrag oder Bestellung hochzuladen. Kommerzielle Entscheidungen bleiben beim BD.</p>
        <form method="get" action="/vertragsbuero#erfassen" className="flex flex-wrap gap-2 items-end text-sm">
          <label className="space-y-1"><span className="block muted text-xs">1. Kunde › Setup</span>
            <select name="setup" className="input" defaultValue={chosen?.id ?? ""} required style={{ minWidth: 320 }}>
              <option value="" disabled>– wählen –</option>
              {choices.setups.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <button className="btn btn-small btn-secondary" type="submit">{chosen ? "Wechseln" : "Weiter"}</button>
        </form>
        {chosen && (
          <form action={captureAssignmentAction} className="grid gap-3 text-sm" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
            <input type="hidden" name="setupId" value={chosen.id} />
            <label className="space-y-1" style={{ gridColumn: "span 2" }}><span className="block muted text-xs">Rolle / Titel</span><input name="title" className="input" required minLength={3} placeholder="z. B. Scrum Master" /></label>
            <label className="space-y-1"><span className="block muted text-xs">Art</span><select name="person" className="input" defaultValue="FREELANCER"><option value="FREELANCER">Freelancer</option><option value="INTERN">intern</option></select></label>
            <label className="space-y-1"><span className="block muted text-xs">Freelancer aus dem Pool</span><select name="freelancerId" className="input" defaultValue=""><option value="">– neu (Name rechts) –</option>{choices.freelancers.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
            <label className="space-y-1"><span className="block muted text-xs">oder neuer Freelancer</span><input name="newName" className="input" placeholder="Vor- und Nachname" /></label>
            <label className="space-y-1"><span className="block muted text-xs">interne Person (bei „intern“)</span><select name="internalUserId" className="input" defaultValue=""><option value="">–</option>{choices.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
            <label className="space-y-1"><span className="block muted text-xs">Start</span><input name="start" type="date" className="input" required /></label>
            <label className="space-y-1"><span className="block muted text-xs">Ende (leer = offen)</span><input name="end" type="date" className="input" /></label>
            <label className="space-y-1"><span className="block muted text-xs">Kündigungs-/Verlängerungsfrist</span><input name="renewalDeadline" type="date" className="input" /></label>
            <label className="space-y-1"><span className="block muted text-xs">EK (Freelancer)</span><input name="ekRate" className="input" inputMode="decimal" /></label>
            <label className="space-y-1"><span className="block muted text-xs">VK</span><input name="vkRate" className="input" inputMode="decimal" /></label>
            <label className="space-y-1"><span className="block muted text-xs">Satz je</span><select name="rateUnit" className="input" defaultValue="TAG"><option value="TAG">Tag</option><option value="STUNDE">Stunde</option></select></label>
            <label className="space-y-1"><span className="block muted text-xs">Bestell-/Vertragsnummer</span><input name="orderReference" className="input" /></label>
            <label className="space-y-1"><span className="block muted text-xs">Verlängerung fachlich über</span><select name="renewalContactPersonId" className="input" defaultValue=""><option value="">– Vorgabe des Setups –</option>{persons.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
            <label className="space-y-1"><span className="block muted text-xs">… oder neuer Ansprechpartner (Name)</span><input name="newRenewalName" className="input" placeholder="Vor- und Nachname" /></label>
            <label className="space-y-1"><span className="block muted text-xs">E-Mail des neuen Ansprechpartners</span><input name="newRenewalEmail" type="email" className="input" /></label>
            <label className="space-y-1"><span className="block muted text-xs">Bestellung/Vertrag über</span><select name="orderContactPersonId" className="input" defaultValue=""><option value="">– Vorgabe des Setups –</option>{persons.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
            <label className="space-y-1"><span className="block muted text-xs">wer spricht an</span><select name="renewalApproach" className="input" defaultValue=""><option value="">– Vorgabe des Setups –</option>{approachValues.map((v) => <option key={v} value={v}>{approachLabel[v]}</option>)}</select></label>
            <label className="space-y-1" style={{ gridColumn: "1 / -1" }}><span className="block muted text-xs">Notiz (optional)</span><input name="note" className="input" maxLength={2000} /></label>
            <div style={{ gridColumn: "1 / -1" }}><PendingButton busy="Lege an …">Assignment anlegen</PendingButton></div>
          </form>
        )}
      </section>
    </div>
  );
}
