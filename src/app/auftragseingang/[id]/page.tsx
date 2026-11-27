import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getCurrentActor } from "@/modules/identity/session";
import { Feedback } from "@/components/Feedback";
import { Icon } from "@/components/Icon";
import { canUseOrderIntake, caseChoices, caseStatusLabel, channelLabel, deviations, getCase, type Suggestion } from "@/modules/o2o/service";
import type { PlanStep } from "@/modules/o2o/plan";
import { NotFoundError } from "@/lib/errors";
import { isoDe } from "@/lib/labels";
import { cancelOrderCaseAction, confirmOrderCaseAction, setEndCustomerAction, uploadOrderCaseAction } from "../../actions";
import { systemStates } from "../SystemDots";

const Ev = ({ f }: { f: { evidence: string; by?: string } | null | undefined }) => (f ? <span className="field-ev" title={f.evidence}>{f.by === "KI" ? <span className="ev-by">KI</span> : null}„{f.evidence.length > 90 ? `${f.evidence.slice(0, 90)} …` : f.evidence}“</span> : <span className="field-ev field-ev-missing">nicht im Dokument gefunden</span>);

export default async function CasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fehler?: string; ok?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!(await canUseOrderIntake(actor))) notFound();
  const c = await getCase(actor, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const sug = (c.parsed ?? {}) as Partial<Suggestion> & { manual?: boolean };
  const p = sug.parsed;
  const draft = c.status === "ENTWURF";
  const choices = draft || c.channel === "VERMITTLER" ? await caseChoices(actor) : null;
  const draftFile = draft && sug.sourceId ? await db.query.documents.findFirst({ where: eq(schema.documents.sourceId, sug.sourceId), columns: { id: true, fileName: true } }) : null;
  const base = draft && sug.matchCaseId ? await getCase(actor, sug.matchCaseId).catch(() => null) : null;
  const dev = base && p?.kind?.value === "BESTELLUNG" ? deviations(base, c) : [];
  const sys = (c.systems ?? {}) as { moco?: { steps: PlanStep[] }; sharepoint?: { state: string; note: string | null; link: string | null } };
  const [opp, eng] = await Promise.all([
    c.opportunityId ? db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, c.opportunityId), columns: { id: true, title: true } }) : null,
    c.engagementId ? db.query.engagements.findFirst({ where: eq(schema.engagements.id, c.engagementId), columns: { id: true, title: true } }) : null,
  ]);
  const kind = p?.kind?.value ?? (c.orderNumber ? "BESTELLUNG" : "ANGEBOT");

  return (
    <div className="space-y-6 max-w-5xl">
      <nav className="crumbs" aria-label="Pfad"><Link href="/einsaetze">Einsätze</Link><Link href="/auftragseingang">Angebot &amp; Bestellung</Link><span>{c.number}</span></nav>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{draft ? "Prüfen und bestätigen" : `${c.role ?? "Vorgang"}${c.personName ? ` – ${c.personName}` : ""}`}</h1>
        <span className="status" data-tone={draft ? "warn" : c.status === "BEAUFTRAGT" ? "ok" : undefined}>{caseStatusLabel[c.status] ?? c.status}</span>
        <span className="muted text-sm">{c.number} · {channelLabel[c.channel]}{c.isRenewal ? " · Verlängerung" : ""} · angelegt von {c.creatorName}</span>
      </div>
      <Feedback params={sp} />

      {draft ? (
        <section className="card">
          <div className="flex flex-wrap gap-3 items-baseline mb-3">
            <h2 className="font-semibold">Gelesen aus {draftFile ? <a href={`/api/dokumente/${draftFile.id}`}>{draftFile.fileName}</a> : sug.manual ? "der Erfassung" : "der Datei"}</h2>
            {sug.extractStatus === "LEER" && <span className="chip" data-tone="warn">Scan ohne Text – Felder bitte von Hand füllen</span>}
            {sug.readNote && <span className="chip" data-tone={sug.readMode === "KI" ? undefined : "warn"} title={sug.readNote}>{sug.readMode === "KI" ? "von der KI gelesen" : "regelbasiert gelesen"}</span>}
            {sug.partnerReason && <span className="muted text-sm">Vertragspartner: {sug.partnerReason}</span>}
          </div>
          {base && (
            <div className="callout mb-3" role="note">
              <Icon name="link" size={18} />
              <div>Gehört vermutlich zu <Link href={`/auftragseingang/${base.id}`}>{base.number}</Link> ({sug.matchReason}).{dev.length > 0 && <> <strong>Abweichungen zum Angebot:</strong> {dev.join("; ")}.</>}</div>
            </div>
          )}
          {sug.renewalEngagementId && (
            <div className="callout mb-3" role="note">
              <Icon name="refresh" size={18} />
              <div>Dieselbe Person läuft bereits bei diesem Kunden – „als Verlängerung übernehmen“ ist vorausgewählt.</div>
            </div>
          )}
          <form action={confirmOrderCaseAction} className="grid sm:grid-cols-3 gap-x-4 gap-y-3">
            <input type="hidden" name="caseId" value={c.id} />
            <div>
              <label className="label" htmlFor="f-kind">Dokumentart</label>
              <select id="f-kind" name="kind" className="input" defaultValue={kind}><option value="ANGEBOT">Angebot</option><option value="BESTELLUNG">Bestellung</option></select>
              <Ev f={p?.kind} />
            </div>
            <div>
              <label className="label" htmlFor="f-channel">Vertriebsweg</label>
              <select id="f-channel" name="channel" className="input" defaultValue={c.channel}><option value="DIREKT">direkt beim Kunden</option><option value="VERMITTLER">über Vermittler</option></select>
            </div>
            <div>
              <label className="label" htmlFor="f-partner">Vertragspartner (Kunde bzw. Vermittler)</label>
              <select id="f-partner" name="partnerAccountId" className="input" defaultValue={c.partnerAccountId ?? ""}>
                <option value="">– neu eintragen –</option>
                {choices!.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.broker ? " (Vermittler)" : ""}</option>)}
              </select>
              <input name="partnerNewName" className="input mt-1" defaultValue={!c.partnerAccountId ? p?.sender?.value ?? "" : ""} placeholder="oder neuer Name" aria-label="Neuer Vertragspartner" />
              {!c.partnerAccountId && <Ev f={p?.sender} />}
            </div>
            <div>
              <label className="label" htmlFor="f-end">Endkunde (nur beim Vermittler)</label>
              <select id="f-end" name="endCustomerAccountId" className="input" defaultValue={c.endCustomerAccountId ?? ""}>
                <option value="">– offen –</option>
                {choices!.accounts.filter((a) => !a.broker).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <input name="endCustomerNewName" className="input mt-1" defaultValue={!c.endCustomerAccountId ? p?.endCustomer?.value ?? "" : ""} placeholder="oder neuer Endkunde" aria-label="Neuer Endkunde" />
              <input name="endCustomerHint" className="input mt-1" defaultValue={c.endCustomerHint ?? ""} placeholder="Hinweis, z. B. „Versicherer, Köln“" aria-label="Hinweis zum Endkunden" />
              <Ev f={p?.endCustomer} />
            </div>
            <div>
              <label className="label" htmlFor="f-pk">Person</label>
              <select id="f-pk" name="personKind" className="input" defaultValue={c.internalUserId ? "INTERN" : "FREELANCER"}><option value="FREELANCER">Freelancer</option><option value="INTERN">intern</option></select>
              <select name="freelancerId" className="input mt-1" defaultValue={c.freelancerId ?? ""} aria-label="Freelancer"><option value="">– Freelancer wählen –</option>{choices!.freelancers.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
              <select name="internalUserId" className="input mt-1" defaultValue={c.internalUserId ?? ""} aria-label="Interne Person"><option value="">– interne Person wählen –</option>{choices!.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
              <input name="personNewName" className="input mt-1" defaultValue={!c.freelancerId && !c.internalUserId ? c.personName ?? "" : ""} placeholder="oder Name (neuer Freelancer)" aria-label="Name der Person" />
              <Ev f={p?.person} />
            </div>
            <div>
              <label className="label" htmlFor="f-role">Rolle</label>
              <input id="f-role" name="role" className="input" defaultValue={c.role ?? ""} placeholder="z. B. Testmanager" />
              <Ev f={p?.role} />
            </div>
            <div>
              <label className="label" htmlFor="f-start">Start</label>
              <input id="f-start" name="startDate" type="date" className="input" defaultValue={c.startDate ?? ""} />
              <Ev f={p?.start} />
            </div>
            <div>
              <label className="label" htmlFor="f-endd">Ende</label>
              <input id="f-endd" name="endDate" type="date" className="input" defaultValue={c.endDate ?? ""} />
              <Ev f={p?.end} />
            </div>
            <div>
              <label className="label" htmlFor="f-rate">Tagessatz (€, Verkauf)</label>
              <input id="f-rate" name="dailyRate" className="input" inputMode="decimal" defaultValue={c.dailyRate ? String(Number(c.dailyRate)).replace(".", ",") : ""} />
              <Ev f={p?.dailyRate} />
            </div>
            <div>
              <label className="label" htmlFor="f-days">Tage</label>
              <input id="f-days" name="days" className="input" inputMode="numeric" defaultValue={c.days ?? ""} />
              <Ev f={p?.days} />
            </div>
            <div>
              <label className="label" htmlFor="f-offer">Angebotsnummer (Moco)</label>
              <input id="f-offer" name="offerNumber" className="input" defaultValue={c.offerNumber ?? ""} />
              <Ev f={p?.offerNumber} />
            </div>
            <div>
              <label className="label" htmlFor="f-ref">Referenz des Vermittlers</label>
              <input id="f-ref" name="brokerRef" className="input" defaultValue={c.brokerRef ?? ""} />
              <Ev f={p?.brokerRef} />
            </div>
            <div>
              <label className="label" htmlFor="f-order">Bestellnummer</label>
              <input id="f-order" name="orderNumber" className="input" defaultValue={c.orderNumber ?? ""} />
              <Ev f={p?.orderNumber} />
            </div>
            <div>
              <label className="label" htmlFor="f-match">Gehört zu Angebot</label>
              <select id="f-match" name="matchCaseId" className="input" defaultValue={sug.matchCaseId ?? ""}>
                <option value="">– kein Angebot (neu) –</option>
                {choices!.openOffers.filter((o) => o.id !== c.id).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="f-ren">Als Verlängerung übernehmen</label>
              <select id="f-ren" name="renewalEngagementId" className="input" defaultValue={sug.renewalEngagementId ?? ""}>
                <option value="">– neuer Einsatz –</option>
                {choices!.running.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="f-bd">Verantwortlicher BD (nur wenn der Kunde noch keinen hat)</label>
              <select id="f-bd" name="bdUserId" className="input" defaultValue=""><option value="">– wie beim Kunden –</option>{choices!.bds.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="f-note">Notiz (optional)</label>
              <input id="f-note" name="note" className="input" />
            </div>
            <div className="sm:col-span-3 flex flex-wrap items-center gap-3">
              {dev.length > 0 && <label className="text-sm flex items-center gap-2"><input type="checkbox" name="deviationsOk" value="on" /> Abweichungen zum Angebot geprüft und bestätigt</label>}
              <button className="btn" type="submit">Bestätigen und anlegen</button>
              <span className="muted text-xs">Geldfelder und Zeitraum bitte einzeln prüfen. Moco wird im Probelauf nur geplant.</span>
            </div>
          </form>
          <form action={cancelOrderCaseAction} className="mt-3">
            <input type="hidden" name="caseId" value={c.id} />
            <button className="btn btn-secondary btn-small" type="submit">Verwerfen</button>
          </form>
        </section>
      ) : (
        <>
          <section className="card">
            <dl className="detail-facts">
              <div><dt className="muted text-xs">Vertragspartner</dt><dd>{c.partnerAccountId ? <Link href={`/kunden/${c.partnerAccountId}`}>{c.partnerName}</Link> : "–"}</dd></div>
              {c.channel === "VERMITTLER" && <div><dt className="muted text-xs">Endkunde</dt><dd>{c.endCustomerAccountId ? <Link href={`/kunden/${c.endCustomerAccountId}`}>{c.endCustomerName}</Link> : <span className="tone-warn">offen{c.endCustomerHint ? ` (${c.endCustomerHint})` : ""}</span>}</dd></div>}
              <div><dt className="muted text-xs">Zeitraum</dt><dd>{c.startDate ? isoDe(c.startDate) : "?"} – {c.endDate ? isoDe(c.endDate) : "?"}</dd></div>
              <div><dt className="muted text-xs">Tagessatz</dt><dd>{c.dailyRate ? `${Number(c.dailyRate).toLocaleString("de-DE")} €` : "–"}{c.days ? ` · ${c.days} Tage` : ""}</dd></div>
              <div><dt className="muted text-xs">Nummern</dt><dd className="text-sm">{[c.offerNumber && `Angebot ${c.offerNumber}`, c.brokerRef && `Ref. ${c.brokerRef}`, c.orderNumber && `Bestellung ${c.orderNumber}`].filter(Boolean).join(" · ") || "–"}</dd></div>
              <div><dt className="muted text-xs">Im Accountmeister</dt><dd className="text-sm">{opp ? <Link href={`/bedarfe/${opp.id}`}>Chance</Link> : "–"}{eng ? <> · <Link href={`/einsaetze/${eng.id}`}>Einsatz</Link></> : null}</dd></div>
            </dl>
            {c.open.length > 0 && <div className="callout mt-3" data-tone="warn" role="note"><Icon name="alert" size={18} /><div><strong>Fehlt noch:</strong> {c.open.join(", ")}.</div></div>}
            {c.statusReason && <p className="muted text-sm mt-2">Notiz: {c.statusReason}</p>}
          </section>

          <div className="grid lg:grid-cols-2 gap-6">
            <section className="card">
              <h2 className="font-semibold mb-2">Unterlagen ({c.documents.length})</h2>
              {c.documents.length === 0 ? <p className="empty">Ohne Dokument erfasst.</p> : (
                <ul className="text-sm space-y-1">
                  {c.documents.map((d) => <li key={d.id}><span className="chip" style={{ marginRight: 6 }}>{d.kind === "BESTELLUNG" ? "Bestellung" : "Angebot"}</span>{d.fileId ? <a href={`/api/dokumente/${d.fileId}`}>{d.fileName ?? d.title}</a> : d.title}{d.link && <> · <a href={d.link} target="_blank" rel="noreferrer">in SharePoint</a></>}</li>)}
                </ul>
              )}
              {c.status === "ANGEBOT_VERSENDET" && (
                <form action={uploadOrderCaseAction} encType="multipart/form-data" className="flex flex-wrap gap-2 items-end mt-3">
                  <input type="hidden" name="forCaseId" value={c.id} />
                  <div className="grow"><label className="label" htmlFor="up-next">Bestellung oder neue Angebotsfassung hochladen</label><input id="up-next" type="file" name="file" required className="input" /></div>
                  <button className="btn btn-small" type="submit">Hochladen</button>
                </form>
              )}
            </section>
            <section className="card">
              <h2 className="font-semibold mb-2">Stand je System</h2>
              <ul className="text-sm space-y-1 mb-3">
                {systemStates(c).map((x) => <li key={x.key}><span className="sys-dot" data-tone={x.tone}>{x.key === "am" ? "AM" : x.key === "sp" ? "SP" : "Moco"}</span> {x.label}: {x.text}{x.key === "sp" && sys.sharepoint?.note ? <span className="muted"> – {sys.sharepoint.note}</span> : null}</li>)}
              </ul>
              {sys.moco?.steps?.length ? (
                <details>
                  <summary className="font-medium text-sm">Moco-Plan ({sys.moco.steps.length} Schritte, Probelauf)</summary>
                  <ol className="text-sm mt-2 space-y-1 list-decimal pl-5">
                    {sys.moco.steps.map((s, i) => <li key={i}><strong>{s.title}</strong>{s.state === "WARTET" && <span className="chip" data-tone="warn" style={{ marginLeft: 6 }}>wartet</span>}<div className="muted text-xs">{s.detail}</div></li>)}
                  </ol>
                  <p className="muted text-xs mt-2">Bis zum Probelauf mit Moco wird nichts geschrieben; das Backoffice legt nach diesem Plan an.</p>
                </details>
              ) : null}
            </section>
          </div>

          {c.channel === "VERMITTLER" && !c.endCustomerAccountId && !c.isRenewal && ["ANGEBOT_VERSENDET", "BEAUFTRAGT"].includes(c.status) && choices && (
            <section className="card">
              <h2 className="font-semibold mb-2">Endkunde nachtragen</h2>
              <form action={setEndCustomerAction} className="flex flex-wrap gap-2 items-end">
                <input type="hidden" name="caseId" value={c.id} />
                <div><label className="label" htmlFor="ec-sel">Kunde</label><select id="ec-sel" name="endCustomerAccountId" className="input" defaultValue=""><option value="">– neu eintragen –</option>{choices.accounts.filter((a) => !a.broker).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
                <div><label className="label" htmlFor="ec-new">oder neuer Endkunde</label><input id="ec-new" name="endCustomerNewName" className="input" /></div>
                <button className="btn" type="submit">Endkunde eintragen</button>
              </form>
              <p className="muted text-xs mt-2">Chance, Einsatz und Unterlagen ziehen zum Endkunden; der Vermittler bleibt Vertragspartner und Rechnungsempfänger.</p>
            </section>
          )}

          {c.status === "ANGEBOT_VERSENDET" && (
            <details className="card">
              <summary className="font-semibold">Absage oder Rückzug</summary>
              <form action={cancelOrderCaseAction} className="flex flex-wrap gap-2 items-end mt-3">
                <input type="hidden" name="caseId" value={c.id} />
                <div className="grow"><label className="label" htmlFor="cx-reason">Grund (optional)</label><input id="cx-reason" name="reason" className="input" /></div>
                <button className="btn btn-secondary" type="submit">Als abgesagt markieren</button>
              </form>
            </details>
          )}
        </>
      )}
    </div>
  );
}
