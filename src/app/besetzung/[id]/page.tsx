import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { DomainError } from "@/lib/errors";
import { getConfig } from "@/lib/config";
import { CANDIDACY_FLOW, CANDIDACY_TERMINAL, candidacyStatusLabel, freelancerOptions, getPositionDetail, positionStatusLabel, rateUnitLabel, resourceKindLabel, scopeUnitLabel, type CandidacyStatus } from "@/modules/staffing/service";
import { QuickFillForm } from "@/components/QuickFillForm";
import { adToText, type AdDraftStored } from "@/modules/staffing/ai";
import { workStatusLabel } from "@/modules/work/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Comments } from "@/components/Work";
import { fmtDate, fmtDateTime } from "@/lib/labels";
import { addCandidacyAction, changeCandidacyStatusAction, changePositionStatusAction, copyPositionAction, generateAdDraftAction, recordFeedbackAction, recordInterviewAction, recordPresentationAction, requestSearchAction, saveAdDraftAction, selectCandidacyAction, updateCandidacyAction, updatePositionAction, workItemAction } from "../../actions";

const eur = (v: string | null, unit: string) => (v ? `${Number(v).toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${rateUnitLabel[unit] ?? unit}` : "offen");

export default async function PositionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  if (getConfig().FEATURE_BESETZUNG !== "true") notFound();
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let d;
  try {
    d = await getPositionDetail(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const back = `/besetzung/${id}`;
  const v = d.view;
  const a = d.access;

  // --- Teamvorschau (Sales Operations vor Übernahme) --------------------------------------------
  if (!a.full) {
    return (
      <div className="space-y-5">
        <p className="text-sm"><Link href="/besetzung">Besetzungen</Link></p>
        <h1 className="text-2xl font-semibold">{v.title}</h1>
        <Feedback params={sp} />
        <section className="card text-sm space-y-2">
          <p className="muted">Teamvorschau – Details, Kandidaturen und Konditionen siehst du nach Übernahme des Suchauftrags.</p>
          <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1">
            <div><dt className="muted">Kunde / Chance</dt><dd>{v.accountName} · {v.opportunityTitle}</dd></div>
            <div><dt className="muted">Verantwortlicher BD</dt><dd>{v.bdName}</dd></div>
            <div><dt className="muted">Gewünschter Start</dt><dd>{fmtDate(v.desiredStart)}</dd></div>
            <div><dt className="muted">Umfang / Ort</dt><dd>{v.scopeAmount ? `${v.scopeAmount} ${scopeUnitLabel[v.scopeUnit ?? ""] ?? ""}` : "–"}{v.location ? ` · ${v.location}` : ""}</dd></div>
            <div><dt className="muted">Zieltermin für Vorschläge</dt><dd>{fmtDate(v.proposalDue)}</dd></div>
            <div><dt className="muted">Stand</dt><dd>{v.progress}</dd></div>
          </dl>
          {v.mustHave && <div><div className="muted">Muss-Anforderungen</div><div style={{ whiteSpace: "pre-wrap" }}>{v.mustHave}</div></div>}
          {d.search && <p>Suchauftrag: <Link href={`/vorgaenge/${d.search.id}`}>{workStatusLabel[d.search.status] ?? d.search.status}</Link>{d.search.dueDate ? ` · bis ${fmtDate(d.search.dueDate)}` : ""} – dort übernehmen.</p>}
        </section>
      </div>
    );
  }

  const p = a.position;
  const final = p.status === "BESETZT" || p.status === "ABGEBROCHEN";
  const intern = p.resourceKind === "INTERN";
  const freelancers = a.manage && !final && !intern ? await freelancerOptions(actor) : [];
  const searchOpen = !!d.search && !["ERLEDIGT", "VERWORFEN", "ABGELEHNT"].includes(d.search.status);
  const ad = (p.adDraft as AdDraftStored | null) ?? null;
  const activeCands = d.candidacies.filter((c) => c.isActive);

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm">
          <Link href="/besetzung">Besetzungen</Link> · <Link href={`/bedarfe/${p.opportunityId}#besetzung`}>{v.accountName} · {v.opportunityTitle}</Link>
          {p.copiedFromId && <> · <Link href={`/besetzung/${p.copiedFromId}`}>Kopie</Link></>}
        </p>
        <h1 className="text-2xl font-semibold mt-1">{p.title}</h1>
        <div className="flex flex-wrap gap-2 items-baseline mt-1">
          <span className="status">{positionStatusLabel[p.status] ?? p.status}</span>
          <span className="status">{resourceKindLabel[p.resourceKind] ?? p.resourceKind}</span>
          <span className="muted text-sm">{v.progress}</span>
          {v.nextDue && <span className="text-sm" style={v.overdue ? { color: "#c0392b", fontWeight: 600 } : undefined}>nächste Frist {fmtDate(v.nextDue)}{v.overdue ? " (überfällig)" : ""}</span>}
          <span className="muted text-xs ml-auto">{a.manage ? "Du führst diese Position (BD-Kontext)." : "Du bearbeitest die Suche (Suchbearbeiter:in)."}</span>
        </div>
      </div>
      <Feedback params={sp} />

      {/* Was fehlt / nächster Schritt */}
      {!final && (
        <section className="card text-sm">
          <strong>Nächster Schritt: </strong>
          {p.status === "ENTWURF" && (d.readiness.length ? `Für „offen“ fehlt noch: ${d.readiness.join(", ")}.` : "Mindestangaben vollständig – Position auf „offen“ setzen.")}
          {p.status === "OFFEN" && !d.search && "Suchauftrag an Sales Operations erteilen (unten) oder selbst Kandidaturen anlegen."}
          {p.status === "OFFEN" && d.search?.status === "ANGEFRAGT" && `Suchauftrag wartet auf Übernahme durch Sales Operations (bis ${fmtDate(d.search.dueDate)}).`}
          {p.status === "OFFEN" && d.search?.status === "RUECKFRAGE" && <>Rückfrage von Sales Operations offen: „{d.search.statusNote}“ – <Link href={`/vorgaenge/${d.search.id}`}>beantworten</Link>.</>}
          {p.status === "OFFEN" && d.search && !["ANGEFRAGT", "RUECKFRAGE"].includes(d.search.status) && (activeCands.some((c) => c.status === "VORGESCHLAGEN") ? "Shortlist prüfen: vorgeschlagene Kandidaturen freigeben oder absagen." : activeCands.some((c) => c.status === "FREIGEGEBEN") ? "Freigegebene Kandidatur beim Kunden vorstellen und dokumentieren." : activeCands.some((c) => ["VORGESTELLT", "INTERVIEW"].includes(c.status)) ? "Interview dokumentieren bzw. Auswahl bestätigen." : `Suche läuft bei ${d.search.assigneeName ?? "Sales Operations"} – Kandidaturen werden hier sichtbar.`)}
          {p.status === "PAUSIERT" && `Pausiert: ${p.statusReason ?? ""} – Prüftermin ${fmtDate(p.holdReviewDate)}.`}
        </section>
      )}

      {/* Bedarfsdaten */}
      <section className="card">
        <details open={p.status === "ENTWURF"}>
          <summary className="font-semibold">Bedarf {p.status === "ENTWURF" ? "(Entwurf – bitte vervollständigen)" : ""}</summary>
          <dl className="text-sm grid sm:grid-cols-3 gap-x-6 gap-y-2 mt-2">
            <div><dt className="muted">Verantwortlicher BD</dt><dd>{v.bdName}</dd></div>
            <div><dt className="muted">Start / Ende</dt><dd>{fmtDate(p.desiredStart)} – {p.endOpen ? "offen" : fmtDate(p.plannedEnd)}</dd></div>
            <div><dt className="muted">Umfang</dt><dd>{p.scopeAmount ? `${p.scopeAmount} ${scopeUnitLabel[p.scopeUnit ?? ""] ?? ""}` : "–"}</dd></div>
            <div><dt className="muted">Einsatzort / Remote</dt><dd>{p.location ?? "–"}</dd></div>
            <div><dt className="muted">Sprache</dt><dd>{p.language ?? "–"}</dd></div>
            <div><dt className="muted">Zieltermin Vorschläge</dt><dd>{fmtDate(p.proposalDue)}</dd></div>
            <div className="sm:col-span-3"><dt className="muted">Muss-Anforderungen</dt><dd style={{ whiteSpace: "pre-wrap" }}>{p.mustHave ?? "–"}</dd></div>
            <div className="sm:col-span-3"><dt className="muted">Aufgaben</dt><dd style={{ whiteSpace: "pre-wrap" }}>{p.tasks ?? "–"}</dd></div>
            <div className="sm:col-span-3"><dt className="muted">Kann-Anforderungen</dt><dd style={{ whiteSpace: "pre-wrap" }}>{p.niceToHave ?? "–"}</dd></div>
            {!intern && <div><dt className="muted">EK-Rahmen (intern)</dt><dd>{p.ekMin || p.ekMax ? `${eur(p.ekMin, p.rateUnit)} – ${eur(p.ekMax, p.rateUnit)}` : "offen"}</dd></div>}
            <div><dt className="muted">Angebotsrahmen Kunde (intern)</dt><dd>{p.vkMin || p.vkMax ? `${eur(p.vkMin, p.rateUnit)} – ${eur(p.vkMax, p.rateUnit)}` : "offen"}</dd></div>
            <div><dt className="muted">Interne Hinweise</dt><dd style={{ whiteSpace: "pre-wrap" }}>{p.internalNotes ?? "–"}</dd></div>
          </dl>
          {a.manage && !final && (
            <details className="mt-3">
              <summary>Bedarf bearbeiten</summary>
              <form action={updatePositionAction} className="grid sm:grid-cols-2 gap-3 mt-2">
                <input type="hidden" name="positionId" value={p.id} />
                <input type="hidden" name="version" value={p.version} />
                <input type="hidden" name="back" value={back} />
                <div className="sm:col-span-2"><label className="label" htmlFor="e-title">Titel / Rolle</label><input id="e-title" name="title" className="input" defaultValue={p.title} required /></div>
                <fieldset className="sm:col-span-2 flex flex-wrap gap-4 items-center">
                  <legend className="label">Ressourcenart</legend>
                  <label className="text-sm flex items-center gap-1"><input type="radio" name="resourceKind" value="FREELANCER" defaultChecked={!intern} /> Freelancer</label>
                  <label className="text-sm flex items-center gap-1"><input type="radio" name="resourceKind" value="INTERN" defaultChecked={intern} /> intern (keine Einkaufskonditionen)</label>
                </fieldset>
                <div>
                  <label className="label" htmlFor="e-bd">Verantwortlicher BD</label>
                  <select id="e-bd" name="bdUserId" className="input" defaultValue={p.bdUserId}>{d.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
                </div>
                <div>
                  <label className="label" htmlFor="e-role">Standardrolle</label>
                  <select id="e-role" name="roleId" className="input" defaultValue={p.roleId ?? ""}><option value="">–</option>{d.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
                </div>
                <div className="sm:col-span-2"><label className="label" htmlFor="e-must">Muss-Anforderungen</label><textarea id="e-must" name="mustHave" className="input" rows={3} defaultValue={p.mustHave ?? ""} /></div>
                <div className="sm:col-span-2"><label className="label" htmlFor="e-tasks">Aufgaben</label><textarea id="e-tasks" name="tasks" className="input" rows={3} defaultValue={p.tasks ?? ""} /></div>
                <div><label className="label" htmlFor="e-nice">Kann-Anforderungen</label><textarea id="e-nice" name="niceToHave" className="input" rows={2} defaultValue={p.niceToHave ?? ""} /></div>
                <div><label className="label" htmlFor="e-loc">Einsatzort / Remote</label><input id="e-loc" name="location" className="input" defaultValue={p.location ?? ""} /></div>
                <div><label className="label" htmlFor="e-lang">Sprache</label><input id="e-lang" name="language" className="input" defaultValue={p.language ?? ""} /></div>
                <div className="grid grid-cols-2 gap-2">
                  <div><label className="label" htmlFor="e-start">Start</label><input id="e-start" type="date" name="desiredStart" className="input" defaultValue={p.desiredStart ?? ""} /></div>
                  <div><label className="label" htmlFor="e-end">Ende</label><input id="e-end" type="date" name="plannedEnd" className="input" defaultValue={p.plannedEnd ?? ""} /></div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div><label className="label" htmlFor="e-scope">Umfang</label><input id="e-scope" type="number" name="scopeAmount" className="input" defaultValue={p.scopeAmount ?? ""} /></div>
                  <div><label className="label" htmlFor="e-unit">Einheit</label><select id="e-unit" name="scopeUnit" className="input" defaultValue={p.scopeUnit ?? "TAGE_PRO_WOCHE"}>{Object.entries(scopeUnitLabel).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                </div>
                <div><label className="label" htmlFor="e-due">Zieltermin Vorschläge</label><input id="e-due" type="date" name="proposalDue" className="input" defaultValue={p.proposalDue ?? ""} /></div>
                <label className="text-sm flex items-center gap-2 self-end"><input type="checkbox" name="endOpen" value="on" defaultChecked={p.endOpen} /> Ende offen</label>
                <fieldset className="sm:col-span-2 grid sm:grid-cols-5 gap-2 border rounded-md p-2" style={{ borderColor: "var(--border)" }}>
                  <legend className="label">Interne Konditionen</legend>
                  {!intern && <div><label className="label" htmlFor="e-ekmin">EK von</label><input id="e-ekmin" name="ekMin" className="input" defaultValue={p.ekMin ?? ""} /></div>}
                  {!intern && <div><label className="label" htmlFor="e-ekmax">EK bis</label><input id="e-ekmax" name="ekMax" className="input" defaultValue={p.ekMax ?? ""} /></div>}
                  <div><label className="label" htmlFor="e-vkmin">Angebot von</label><input id="e-vkmin" name="vkMin" className="input" defaultValue={p.vkMin ?? ""} /></div>
                  <div><label className="label" htmlFor="e-vkmax">Angebot bis</label><input id="e-vkmax" name="vkMax" className="input" defaultValue={p.vkMax ?? ""} /></div>
                  <div><label className="label" htmlFor="e-rate">je</label><select id="e-rate" name="rateUnit" className="input" defaultValue={p.rateUnit}><option value="TAG">Tag</option><option value="STUNDE">Stunde</option></select></div>
                </fieldset>
                <div className="sm:col-span-2"><label className="label" htmlFor="e-notes">Interne Hinweise</label><textarea id="e-notes" name="internalNotes" className="input" rows={2} defaultValue={p.internalNotes ?? ""} /></div>
                <div className="sm:col-span-2"><button className="btn btn-small" type="submit">Speichern</button></div>
              </form>
            </details>
          )}
        </details>
      </section>

      {/* Status-Aktionen */}
      {a.manage && !final && (
        <section className="card flex flex-wrap gap-4 items-end text-sm">
          {p.status === "ENTWURF" && (
            <form action={changePositionStatusAction}>
              <input type="hidden" name="positionId" value={p.id} /><input type="hidden" name="version" value={p.version} /><input type="hidden" name="back" value={back} /><input type="hidden" name="status" value="OFFEN" />
              <button className="btn btn-small" type="submit" disabled={d.readiness.length > 0} title={d.readiness.length ? `Fehlt: ${d.readiness.join(", ")}` : undefined}>Auf „offen“ setzen</button>
            </form>
          )}
          {p.status === "PAUSIERT" && (
            <form action={changePositionStatusAction}>
              <input type="hidden" name="positionId" value={p.id} /><input type="hidden" name="version" value={p.version} /><input type="hidden" name="back" value={back} /><input type="hidden" name="status" value="OFFEN" />
              <button className="btn btn-small" type="submit">Wieder öffnen</button>
            </form>
          )}
          {p.status === "OFFEN" && (
            <form action={changePositionStatusAction} className="flex flex-wrap gap-2 items-end">
              <input type="hidden" name="positionId" value={p.id} /><input type="hidden" name="version" value={p.version} /><input type="hidden" name="back" value={back} /><input type="hidden" name="status" value="PAUSIERT" />
              <input name="reason" className="input" placeholder="Grund der Pause" aria-label="Grund der Pause" required />
              <div><label className="label" htmlFor="hold">Prüftermin</label><input id="hold" type="date" name="holdReviewDate" className="input" required /></div>
              <button className="btn btn-secondary btn-small" type="submit">Pausieren</button>
            </form>
          )}
          <form action={changePositionStatusAction} className="flex flex-wrap gap-2 items-end">
            <input type="hidden" name="positionId" value={p.id} /><input type="hidden" name="version" value={p.version} /><input type="hidden" name="back" value={back} /><input type="hidden" name="status" value="ABGEBROCHEN" />
            <input name="reason" className="input" placeholder="Grund (Pflicht)" aria-label="Grund des Abbruchs" required />
            <button className="btn btn-secondary btn-small" type="submit">Ohne Besetzung beenden</button>
          </form>
          <form action={copyPositionAction}>
            <input type="hidden" name="positionId" value={p.id} /><input type="hidden" name="back" value={back} />
            <button className="btn btn-secondary btn-small" type="submit">Kopieren (weiterer Platz)</button>
          </form>
        </section>
      )}
      {final && a.manage && (
        <section className="card text-sm flex flex-wrap gap-3 items-center">
          <span>{p.status === "BESETZT" ? <>Besetzt am {fmtDate(p.filledAt)}. Weiter im Abschluss der Chance: <Link href={`/bedarfe/${p.opportunityId}#auftrag`}>Angebot/Auftrag</Link>.</> : `Abgebrochen: ${p.statusReason ?? ""}`}</span>
          <form action={copyPositionAction} className="ml-auto">
            <input type="hidden" name="positionId" value={p.id} /><input type="hidden" name="back" value={back} />
            <button className="btn btn-secondary btn-small" type="submit">{p.status === "BESETZT" ? "Nachbesetzung / weiterer Platz (Kopie)" : "Erneut anlegen (Kopie)"}</button>
          </form>
        </section>
      )}

      {/* Schnellbesetzung */}
      {a.manage && !final && (
        <section className="card" id="schnellbesetzung">
          <h2 className="font-semibold mb-1">Schnellbesetzung</h2>
          <p className="text-sm muted">Steht die Person fest (intern oder Freelancer)? Dann hier direkt besetzen – ohne Suchauftrag und Kandidaturen-Schritte. Ein offener Suchauftrag wird dabei erledigt.</p>
          <details>
            <summary>Direkt besetzen</summary>
            <QuickFillForm opportunityId={p.opportunityId} positionId={p.id} back={back} users={d.users} freelancers={freelancers} defaults={{ resourceKind: p.resourceKind, desiredStart: p.desiredStart, plannedEnd: p.plannedEnd, endOpen: p.endOpen }} />
          </details>
        </section>
      )}

      {/* Suchauftrag */}
      <section className="card" id="suche">
        <h2 className="font-semibold mb-1">Suchauftrag</h2>
        {d.search ? (
          <p className="text-sm">
            <Link href={`/vorgaenge/${d.search.id}`}>Vorgang öffnen</Link> · {workStatusLabel[d.search.status] ?? d.search.status}
            {d.search.assigneeName ? ` · bearbeitet von ${d.search.assigneeName}` : " · noch nicht übernommen"}
            {d.search.dueDate ? ` · bis ${fmtDate(d.search.dueDate)}` : ""}
            {d.search.status === "RUECKFRAGE" && d.search.statusNote ? <> · Rückfrage: „{d.search.statusNote}“</> : null}
          </p>
        ) : (
          <p className="muted text-sm">Noch kein Suchauftrag.</p>
        )}
        {a.manage && d.search && searchOpen && (
          <form action={workItemAction} className="flex flex-wrap gap-2 items-end mt-2">
            <input type="hidden" name="workItemId" value={d.search.id} />
            <input type="hidden" name="version" value={d.search.version} />
            <input type="hidden" name="back" value={`${back}#suche`} />
            <input type="hidden" name="action" value="ABSCHLIESSEN" />
            <div className="grow"><label className="label" htmlFor="s-done">Suchauftrag selbst als erledigt setzen – kurz warum</label><input id="s-done" name="result" className="input" maxLength={4000} placeholder="z. B. anderweitig besetzt, Bedarf entfallen" /></div>
            <button className="btn btn-secondary btn-small" type="submit">Als erledigt setzen</button>
          </form>
        )}
        {a.manage && p.status === "OFFEN" && (!d.search || ["ERLEDIGT", "VERWORFEN", "ABGELEHNT"].includes(d.search.status)) && (
          <form action={requestSearchAction} className="grid sm:grid-cols-2 gap-3 mt-2">
            <input type="hidden" name="positionId" value={p.id} /><input type="hidden" name="back" value={back} />
            <div className="sm:col-span-2"><label className="label" htmlFor="s-res">Erwartetes Ergebnis</label><textarea id="s-res" name="expectedResult" className="input" rows={2} required minLength={10} placeholder="z. B. zwei qualifizierte Profile mit EK bis … und Verfügbarkeit ab …" /></div>
            <div><label className="label" htmlFor="s-due">Fällig bis {p.proposalDue ? `(leer = Zieltermin ${fmtDate(p.proposalDue)})` : ""}</label><input id="s-due" type="date" name="dueDate" className="input" /></div>
            <div><label className="label" htmlFor="s-prio">Priorität</label><select id="s-prio" name="priority" className="input" defaultValue="NORMAL"><option value="NORMAL">normal</option><option value="HOCH">dringend</option></select></div>
            <div className="sm:col-span-2"><button className="btn btn-small" type="submit">An Sales Operations geben</button></div>
          </form>
        )}
      </section>

      {/* Kandidaturen */}
      <section className="card" id="kandidaturen">
        <h2 className="font-semibold mb-2">Kandidaturen ({activeCands.length})</h2>
        {activeCands.length === 0 && <p className="muted text-sm">Noch keine Kandidatur.</p>}
        <ul className="space-y-4">
          {activeCands.map((c) => {
            const st = c.status as CandidacyStatus;
            const terminal = CANDIDACY_TERMINAL.includes(st);
            const idx = CANDIDACY_FLOW.indexOf(st);
            const nextStatuses = terminal || st === "AUSGEWAEHLT" ? [] : CANDIDACY_FLOW.slice(idx + 1).filter((x) => x !== "VORGESTELLT" && x !== "AUSGEWAEHLT" && (x !== "FREIGEGEBEN" || a.manage) && (x !== "INTERVIEW" || st === "VORGESTELLT"));
            const canSelect = a.manage && ["FREIGEGEBEN", "VORGESTELLT", "INTERVIEW"].includes(st) && p.status === "OFFEN";
            return (
              <li key={c.id} className="border rounded-md p-3" style={{ borderColor: st === "AUSGEWAEHLT" ? "#2f7d32" : "var(--border)" }}>
                <div className="flex flex-wrap items-baseline gap-2">
                  {c.freelancerId ? <Link href={`/besetzung/freelancer/${c.freelancerId}`}><strong>{c.personName}</strong></Link> : <strong>{c.personName}</strong>}
                  <span className="status">{candidacyStatusLabel[c.status] ?? c.status}</span>
                  <span className="muted text-xs">bearbeitet von {c.handlerName}{c.freelancer?.company ? ` · ${c.freelancer.company}` : ""}{c.originRef ? ` · Quelle: ${c.originRef}` : ""}</span>
                </div>
                <dl className="text-sm grid sm:grid-cols-4 gap-x-4 gap-y-1 mt-1">
                  <div><dt className="muted">Verfügbar</dt><dd>{c.availableFrom ? `${fmtDate(c.availableFrom)}${c.availableTo ? ` – ${fmtDate(c.availableTo)}` : ""}` : "offen"}</dd></div>
                  <div><dt className="muted">EK (Stand {fmtDate(c.ekAsOf)})</dt><dd>{eur(c.ekRate, c.rateUnit)}{c.ekNote ? ` · ${c.ekNote}` : ""}</dd></div>
                  <div><dt className="muted">Angebot</dt><dd>{eur(c.vkRate, c.rateUnit)}</dd></div>
                  <div><dt className="muted">Nächster Schritt</dt><dd>{c.nextStep ?? "–"}{c.nextStepDue ? ` (${fmtDate(c.nextStepDue)})` : ""}</dd></div>
                  {c.notes && <div className="sm:col-span-4"><dt className="muted">Interne Notizen (kundenspezifisch)</dt><dd style={{ whiteSpace: "pre-wrap" }}>{c.notes}</dd></div>}
                  {c.statusReason && <div className="sm:col-span-4"><dt className="muted">Begründung</dt><dd>{c.statusReason}</dd></div>}
                </dl>
                {c.events.filter((e) => e.kind !== "STATUS").length > 0 && (
                  <ul className="text-xs mt-2 space-y-1">
                    {c.events.filter((e) => e.kind !== "STATUS").map((e) => (
                      <li key={e.id}>
                        <span className="muted">{fmtDate(e.at)}</span> · {e.kind === "VORSTELLUNG" ? `Vorgestellt an ${e.recipientName ?? e.recipientText ?? "?"} · Profil ${e.profileRef} (Prüfsumme ${e.profileHash}) · Weitergabe: ${e.releaseScope}${e.pricePresented ? ` · Preis ${eur(e.pricePresented, e.priceUnit ?? "TAG")}` : ""}${e.summary ? ` · „${e.summary}“` : ""}` : e.kind === "INTERVIEW" ? `Interview ${e.interviewStatus?.toLowerCase()}${e.interviewAt ? ` am ${fmtDateTime(e.interviewAt)}` : ""}${e.participants ? ` · ${e.participants}` : ""}${e.outcome ? ` · Ergebnis: ${e.outcome}` : ""}${e.reason ? ` · ${e.reason}` : ""}` : e.kind === "RUECKMELDUNG" ? `Kundenrückmeldung: ${e.outcome}` : e.kind === "ABSAGE" ? `${candidacyStatusLabel[e.toStatus ?? ""] ?? "Absage"}: ${e.reason}` : e.kind === "WIEDERAUFNAHME" ? `Wiederaufnahme: ${e.reason}` : e.kind === "AUSWAHL" ? `Auswahl bestätigt${e.reason ? ` (${e.reason})` : ""}` : e.kind} · {e.who}
                      </li>
                    ))}
                  </ul>
                )}
                {!final && (
                  <div className="mt-2 space-y-2 text-sm">
                    {nextStatuses.length > 0 && (
                      <form action={changeCandidacyStatusAction} className="flex flex-wrap gap-2 items-end">
                        <input type="hidden" name="candidacyId" value={c.id} /><input type="hidden" name="version" value={c.version} /><input type="hidden" name="back" value={`${back}#kandidaturen`} />
                        <select name="status" className="input" defaultValue={nextStatuses[0]} aria-label="Nächster Status">{nextStatuses.map((x) => <option key={x} value={x}>{candidacyStatusLabel[x]}</option>)}</select>
                        <input name="reason" className="input" placeholder="Grund (bei Überspringen Pflicht)" aria-label="Grund" style={{ minWidth: 220 }} />
                        <button className="btn btn-small" type="submit">Weiter</button>
                      </form>
                    )}
                    {a.manage && st === "FREIGEGEBEN" && (
                      <details>
                        <summary>Vorstellung beim Kunden dokumentieren</summary>
                        <form action={recordPresentationAction} className="grid sm:grid-cols-2 gap-2 mt-2">
                          <input type="hidden" name="candidacyId" value={c.id} /><input type="hidden" name="version" value={c.version} /><input type="hidden" name="back" value={`${back}#kandidaturen`} />
                          <div><label className="label">Datum</label><input type="date" name="at" className="input" required /></div>
                          <div>
                            <label className="label">Empfänger (Ansprechperson)</label>
                            <select name="recipientPersonId" className="input" defaultValue=""><option value="">– frei eintragen –</option>{d.persons.map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}</select>
                          </div>
                          <div><label className="label">Empfänger (frei)</label><input name="recipientText" className="input" placeholder="falls nicht in der Liste" /></div>
                          <div><label className="label">Profil-/CV-Stand (Pflicht)</label><input name="profileRef" className="input" required placeholder="Dateiname oder Link mit Versionsdatum" /></div>
                          <div className="sm:col-span-2"><label className="label">Kundenfähige Zusammenfassung</label><textarea name="summary" className="input" rows={2} /></div>
                          <div className="sm:col-span-2"><label className="label">Erlaubte Weitergabe (Umfang, Stand, wer bestätigt) – Pflicht</label><input name="releaseScope" className="input" required placeholder="z. B. Profil ohne Kontaktdaten, Stand 09.10., per Mail bestätigt von …" /></div>
                          <div><label className="label">Bestätigt durch</label><input name="releaseConfirmedBy" className="input" /></div>
                          <div><label className="label">Stand vom</label><input type="date" name="releaseAsOf" className="input" /></div>
                          <div><label className="label">Vorgestellter Preis</label><input name="pricePresented" className="input" inputMode="decimal" placeholder="€" /></div>
                          <div><label className="label">je</label><select name="priceUnit" className="input" defaultValue="TAG"><option value="TAG">Tag</option><option value="STUNDE">Stunde</option></select></div>
                          <div><label className="label">Kommunikationsreferenz</label><input name="communicationRef" className="input" placeholder="z. B. Mail vom 10.10." /></div>
                          <div><label className="label">Nächste Rückfrage</label><input name="nextStep" className="input" /></div>
                          <div className="sm:col-span-2"><button className="btn btn-small" type="submit">Vorstellung dokumentieren</button></div>
                        </form>
                      </details>
                    )}
                    {["VORGESTELLT", "INTERVIEW"].includes(st) && (
                      <details>
                        <summary>Interview dokumentieren</summary>
                        <form action={recordInterviewAction} className="grid sm:grid-cols-2 gap-2 mt-2">
                          <input type="hidden" name="candidacyId" value={c.id} /><input type="hidden" name="version" value={c.version} /><input type="hidden" name="back" value={`${back}#kandidaturen`} />
                          <div><label className="label">Status</label><select name="interviewStatus" className="input" defaultValue="GEPLANT"><option value="ANGEFRAGT">angefragt</option><option value="GEPLANT">geplant</option><option value="DURCHGEFUEHRT">durchgeführt</option><option value="ABGESAGT">abgesagt</option></select></div>
                          <div><label className="label">Termin</label><input type="datetime-local" name="interviewAt" className="input" /></div>
                          <div><label className="label">Beteiligte</label><input name="participants" className="input" /></div>
                          <div><label className="label">Grund (bei Absage)</label><input name="reason" className="input" /></div>
                          <div className="sm:col-span-2"><label className="label">Ergebnis (bei durchgeführt)</label><textarea name="outcome" className="input" rows={2} /></div>
                          <div className="sm:col-span-2"><button className="btn btn-small" type="submit">Speichern</button></div>
                        </form>
                      </details>
                    )}
                    {a.manage && ["VORGESTELLT", "INTERVIEW"].includes(st) && (
                      <form action={recordFeedbackAction} className="flex flex-wrap gap-2 items-end">
                        <input type="hidden" name="candidacyId" value={c.id} /><input type="hidden" name="version" value={c.version} /><input type="hidden" name="back" value={`${back}#kandidaturen`} />
                        <input name="feedback" className="input" placeholder="Kundenrückmeldung" aria-label="Kundenrückmeldung" style={{ minWidth: 280 }} required />
                        <button className="btn btn-secondary btn-small" type="submit">Rückmeldung festhalten</button>
                      </form>
                    )}
                    {canSelect && (
                      <form action={selectCandidacyAction} className="flex flex-wrap gap-2 items-end border rounded-md p-2" style={{ borderColor: "#2f7d32" }}>
                        <input type="hidden" name="candidacyId" value={c.id} /><input type="hidden" name="version" value={c.version} /><input type="hidden" name="back" value={back} />
                        <label className="text-sm flex items-center gap-2"><input type="checkbox" name="confirm" value="on" required /> Ich bestätige die Auswahl dieser Person für die Position.</label>
                        {st !== "INTERVIEW" && <input name="reason" className="input" placeholder="Begründung (ohne Interview Pflicht)" aria-label="Begründung" />}
                        <button className="btn btn-small" type="submit">Auswahl bestätigen</button>
                      </form>
                    )}
                    {!terminal && st !== "AUSGEWAEHLT" && (
                      <form action={changeCandidacyStatusAction} className="flex flex-wrap gap-2 items-end">
                        <input type="hidden" name="candidacyId" value={c.id} /><input type="hidden" name="version" value={c.version} /><input type="hidden" name="back" value={`${back}#kandidaturen`} />
                        <select name="status" className="input" defaultValue="ABGELEHNT" aria-label="Beenden als"><option value="ABGELEHNT">abgelehnt</option><option value="ZURUECKGEZOGEN">zurückgezogen</option><option value="NICHT_VERFUEGBAR">nicht verfügbar</option></select>
                        <input name="reason" className="input" placeholder="Grund (Pflicht)" aria-label="Grund" required />
                        <button className="btn btn-secondary btn-small" type="submit">Beenden</button>
                      </form>
                    )}
                    {terminal && (
                      <form action={changeCandidacyStatusAction} className="flex flex-wrap gap-2 items-end">
                        <input type="hidden" name="candidacyId" value={c.id} /><input type="hidden" name="version" value={c.version} /><input type="hidden" name="back" value={`${back}#kandidaturen`} /><input type="hidden" name="status" value="QUALIFIZIERT" />
                        <input name="reason" className="input" placeholder="Grund der Wiederaufnahme" required />
                        <input name="availabilityNote" className="input" placeholder="aktualisierte Verfügbarkeit" required />
                        <button className="btn btn-secondary btn-small" type="submit">Wieder aufnehmen</button>
                      </form>
                    )}
                    {!terminal && st !== "AUSGEWAEHLT" && (
                      <details>
                        <summary>Konditionen / Notizen bearbeiten</summary>
                        <form action={updateCandidacyAction} className="grid sm:grid-cols-4 gap-2 mt-2">
                          <input type="hidden" name="candidacyId" value={c.id} /><input type="hidden" name="version" value={c.version} /><input type="hidden" name="back" value={`${back}#kandidaturen`} />
                          <div><label className="label">Verfügbar ab</label><input type="date" name="availableFrom" className="input" defaultValue={c.availableFrom ?? ""} /></div>
                          <div><label className="label">bis</label><input type="date" name="availableTo" className="input" defaultValue={c.availableTo ?? ""} /></div>
                          <div><label className="label">EK</label><input name="ekRate" className="input" defaultValue={c.ekRate ?? ""} inputMode="decimal" /></div>
                          <div><label className="label">EK-Stand</label><input type="date" name="ekAsOf" className="input" defaultValue={c.ekAsOf ?? ""} /></div>
                          <div><label className="label">Angebot</label><input name="vkRate" className="input" defaultValue={c.vkRate ?? ""} inputMode="decimal" /></div>
                          <div><label className="label">je</label><select name="rateUnit" className="input" defaultValue={c.rateUnit}><option value="TAG">Tag</option><option value="STUNDE">Stunde</option></select></div>
                          <div><label className="label">Herkunft / Ranking-Referenz</label><input name="originRef" className="input" defaultValue={c.originRef ?? ""} /></div>
                          <div><label className="label">EK-Notiz</label><input name="ekNote" className="input" defaultValue={c.ekNote ?? ""} /></div>
                          <div className="sm:col-span-2"><label className="label">Interne Notizen</label><textarea name="notes" className="input" rows={2} defaultValue={c.notes ?? ""} /></div>
                          <div><label className="label">Nächster Schritt</label><input name="nextStep" className="input" defaultValue={c.nextStep ?? ""} /></div>
                          <div><label className="label">bis</label><input type="date" name="nextStepDue" className="input" defaultValue={c.nextStepDue ?? ""} /></div>
                          <div className="sm:col-span-4"><button className="btn btn-small" type="submit">Speichern</button></div>
                        </form>
                      </details>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {!final && (a.manage || a.searcher) && (
          <details className="mt-3">
            <summary>Kandidatur anlegen</summary>
            <form action={addCandidacyAction} className="grid sm:grid-cols-4 gap-2 mt-2">
              <input type="hidden" name="positionId" value={p.id} /><input type="hidden" name="back" value={`${back}#kandidaturen`} />
              {intern ? (
                <div className="sm:col-span-2"><label className="label" htmlFor="c-user">Interne Person</label><select id="c-user" name="internalUserId" className="input" required defaultValue=""><option value="" disabled>bitte wählen</option>{d.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
              ) : (
                <>
                  <div className="sm:col-span-2"><label className="label" htmlFor="c-name">Neuer Freelancer: Name</label><input id="c-name" name="newName" className="input" placeholder="oder unten eine bestehende ID wählen" /></div>
                  <div><label className="label" htmlFor="c-mail">E-Mail</label><input id="c-mail" name="newEmail" className="input" /></div>
                  <div><label className="label" htmlFor="c-comp">Firma</label><input id="c-comp" name="newCompany" className="input" /></div>
                  <div className="sm:col-span-2"><label className="label" htmlFor="c-skills">Skills (kurz)</label><input id="c-skills" name="newSkills" className="input" /></div>
                  <div className="sm:col-span-2"><label className="label" htmlFor="c-fid">Bestehender Freelancer (ID aus dem Pool)</label><input id="c-fid" name="freelancerId" className="input" placeholder="leer = neu anlegen" /></div>
                </>
              )}
              <div><label className="label" htmlFor="c-from">Verfügbar ab</label><input id="c-from" type="date" name="availableFrom" className="input" /></div>
              {!intern && <div><label className="label" htmlFor="c-ek">EK</label><input id="c-ek" name="ekRate" className="input" inputMode="decimal" placeholder="€" /></div>}
              <div><label className="label" htmlFor="c-unit">je</label><select id="c-unit" name="rateUnit" className="input" defaultValue="TAG"><option value="TAG">Tag</option><option value="STUNDE">Stunde</option></select></div>
              <div><label className="label" htmlFor="c-origin">Herkunft / Ranking-Referenz</label><input id="c-origin" name="originRef" className="input" /></div>
              <div className="sm:col-span-4"><label className="label" htmlFor="c-notes">Interne Notizen</label><textarea id="c-notes" name="notes" className="input" rows={2} /></div>
              <div className="sm:col-span-4"><button className="btn btn-small" type="submit">Kandidatur anlegen</button></div>
            </form>
            <p className="muted text-xs mt-1">Dublettenhinweis: Vor dem Anlegen im <Link href="/besetzung/freelancer">Pool</Link> nach dem Namen suchen (Sales Operations, Principal, CEO). Keine Bank-, Ausweis- oder Steuerdaten erfassen.</p>
          </details>
        )}
      </section>

      {/* Ausschreibungsentwurf */}
      <section className="card" id="ausschreibung">
        <div className="flex flex-wrap items-baseline gap-2 mb-1">
          <h2 className="font-semibold">Ausschreibungsentwurf</h2>
          <span className="status">{p.adStatus === "FREIGEGEBEN" ? "freigegeben" : p.adStatus === "ENTWURF" ? "Entwurf" : "kein Entwurf"}</span>
          <span className="muted text-xs">Nur aus freigegebenen Bedarfsfeldern – ohne EK, interne Hinweise oder nicht freigegebenen Kundennamen. Veröffentlichen bleibt manuell (Text kopieren).</span>
        </div>
        {ad && (
          <>
            <p className="muted text-xs">{ad.note} · Kanal {ad.channel} · Ton {ad.tone} · {ad.promptVersion} · erzeugt {fmtDateTime(ad.generatedAt)}{p.adApprovedAt ? ` · freigegeben ${fmtDateTime(p.adApprovedAt)}` : ""}</p>
            {ad.missing.length > 0 && <p className="text-sm mt-1"><strong>Offen:</strong> {ad.missing.join(" · ")}</p>}
            <label className="label mt-2" htmlFor="ad-text">Text zum Kopieren</label>
            <textarea id="ad-text" className="input" rows={10} readOnly defaultValue={adToText(ad)} />
            {!final && (a.manage || a.searcher) && (
              <details className="mt-2">
                <summary>{p.adStatus === "FREIGEGEBEN" ? "Freigabe zurücknehmen" : "Bearbeiten / freigeben"}</summary>
                <form action={saveAdDraftAction} className="grid gap-2 mt-2">
                  <input type="hidden" name="positionId" value={p.id} /><input type="hidden" name="version" value={p.version} /><input type="hidden" name="back" value={`${back}#ausschreibung`} />
                  {p.adStatus === "FREIGEGEBEN" ? (
                    <>
                      <input type="hidden" name="title" value={ad.title} /><input type="hidden" name="withdraw" value="on" />
                      <div><button className="btn btn-secondary btn-small" type="submit">Freigabe zurücknehmen</button></div>
                    </>
                  ) : (
                    <>
                      <div><label className="label">Titel</label><input name="title" className="input" defaultValue={ad.title} required /></div>
                      <div><label className="label">Einleitung</label><textarea name="intro" className="input" rows={2} defaultValue={ad.intro} /></div>
                      <div><label className="label">Aufgaben (je Zeile)</label><textarea name="tasksText" className="input" rows={3} defaultValue={ad.tasks.join("\n")} /></div>
                      <div><label className="label">Muss (je Zeile)</label><textarea name="mustText" className="input" rows={3} defaultValue={ad.must.join("\n")} /></div>
                      <div><label className="label">Kann (je Zeile)</label><textarea name="niceText" className="input" rows={2} defaultValue={ad.nice.join("\n")} /></div>
                      <div><label className="label">Rahmen (je Zeile)</label><textarea name="conditionsText" className="input" rows={2} defaultValue={ad.conditions.join("\n")} /></div>
                      <div className="flex flex-wrap gap-2">
                        <button className="btn btn-secondary btn-small" type="submit">Entwurf speichern</button>
                        {a.manage && <button className="btn btn-small" type="submit" name="approve" value="on">Speichern und freigeben</button>}
                      </div>
                    </>
                  )}
                </form>
              </details>
            )}
          </>
        )}
        {!final && (a.manage || a.searcher) && p.adStatus !== "FREIGEGEBEN" && (
          <form action={generateAdDraftAction} className="flex flex-wrap gap-2 items-end mt-3">
            <input type="hidden" name="positionId" value={p.id} /><input type="hidden" name="version" value={p.version} /><input type="hidden" name="back" value={`${back}#ausschreibung`} />
            <div><label className="label" htmlFor="ad-ch">Zielkanal</label><select id="ad-ch" name="channel" className="input" defaultValue="FREELANCER_PLATTFORM"><option value="FREELANCER_PLATTFORM">Freelancer-Plattform</option><option value="NETZWERK">Netzwerk</option><option value="INTERN">intern</option></select></div>
            <div><label className="label" htmlFor="ad-tone">Ton</label><select id="ad-tone" name="tone" className="input" defaultValue="SACHLICH"><option value="SACHLICH">sachlich</option><option value="ANSPRECHEND">ansprechend</option></select></div>
            <div className="grow"><label className="label" htmlFor="ad-rel">Ausdrücklich freigegebene Zusatzinfos (z. B. Branche, Kundenname) – sonst leer</label><input id="ad-rel" name="releasedInfo" className="input" maxLength={500} /></div>
            <button className="btn btn-small" type="submit">{ad ? "Neu entwerfen" : "Entwurf erzeugen"}</button>
          </form>
        )}
      </section>

      <Comments actor={actor} subjectType="CHANCE" subjectId={p.opportunityId} back={back} />

      <section className="card">
        <details>
          <summary className="font-semibold">Verlauf ({d.history.length})</summary>
          <ul className="text-sm mt-2 space-y-1">
            {d.history.map((h, i) => (
              <li key={i}><span className="muted">{fmtDateTime(h.at)}</span> · {h.who}: {h.action.replace("position.", "")}{h.changes && "nach" in h.changes ? ` → ${positionStatusLabel[String(h.changes.nach)] ?? String(h.changes.nach)}` : ""}</li>
            ))}
          </ul>
        </details>
      </section>
    </div>
  );
}
