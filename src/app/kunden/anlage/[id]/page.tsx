import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { schema } from "@/db/client";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { getIntake } from "@/modules/intake/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { accessClassLabel, extractStatusLabel, intakeStatusLabel, orgTypeLabel } from "@/lib/labels";
import { applyIntakeAction, discardIntakeAction } from "../../../actions";

/**
 * Schritt 2: Anlagevorschlag prüfen. Alles ist editierbar; Häkchen entscheidet, was angelegt wird.
 * Rechts (bzw. unten) steht der Dokumenttext, damit jede Textstelle nachgelesen werden kann.
 */
export default async function AnlagevorschlagPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let d;
  try {
    d = await getIntake(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const p = d.payload;
  const done = d.proposal.status !== "ENTWURF";
  const existing = p.organization?.possibleExistingAccount ? d.accounts.find((a) => a.name === p.organization?.possibleExistingAccount) : undefined;
  const quote = (q: string) => <span className="muted text-xs block mt-1">Textstelle: „{q.length > 160 ? q.slice(0, 157) + "…" : q}“</span>;

  return (
    <div className="space-y-6">
      <p className="text-sm"><Link href="/kunden">← Kunden</Link></p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Anlagevorschlag {p.organization?.name ? `„${p.organization.name}“` : ""}</h1>
        <Status label={intakeStatusLabel[d.proposal.status] ?? d.proposal.status} />
      </div>
      <Feedback params={sp} />

      <section className="card text-sm">
        <div className="grid sm:grid-cols-3 gap-x-6 gap-y-1">
          <div><span className="muted">Dokument: </span>{d.source ? <Link href={`/quellen/${d.source.id}`}>{d.source.title}</Link> : "–"}{d.document ? <> · <Status label={extractStatusLabel[d.document.extractStatus] ?? d.document.extractStatus} /></> : null}</div>
          <div><span className="muted">KI: </span>{p.aiStatus === "vorschlag" ? "Vorschlag erzeugt" : p.aiStatus === "fehler" ? "Fehler" : "ohne KI"}{p.rejected > 0 ? ` · ${p.rejected} Element(e) ohne Textbeleg verworfen` : ""}</div>
          <div><span className="muted">Erstellt: </span>{d.proposal.createdAt.toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}</div>
        </div>
        {p.aiNote && <p className="mt-2">{p.aiNote}</p>}
        {p.summary && <p className="mt-2"><span className="muted">Zusammenfassung (KI, Sachverhalt): </span>{p.summary}</p>}
        {p.noProposalReason && <p className="mt-2"><span className="muted">Kein Vorschlag: </span>{p.noProposalReason}</p>}
        {p.openQuestions.length > 0 && (
          <div className="mt-2"><span className="muted">Vor der Bestätigung klären: </span><ul className="list-disc ml-5">{p.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>
        )}
        {done && d.proposal.resultSetupId && <p className="mt-2">Übernommen: <Link href={`/setups/${d.proposal.resultSetupId}`}>zum Setup</Link>{d.proposal.resultAccountId ? <> · <Link href={`/kunden/${d.proposal.resultAccountId}`}>zum Kunden</Link></> : null}</p>}
      </section>

      {!done && (
        <div className="grid lg:grid-cols-[3fr_2fr] gap-6 items-start">
          <form action={applyIntakeAction} className="space-y-6">
            <input type="hidden" name="proposalId" value={d.proposal.id} />

            <section className="card">
              <h2 className="font-semibold mb-2">1. Kunde</h2>
              {existing && <p className="text-sm mb-2">Die KI vermutet, dass das Dokument zum bestehenden Kunden <strong>{existing.name}</strong> gehört. Wählen Sie ihn unten, wenn das stimmt – dann wird kein neuer Kunde angelegt.</p>}
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="existingAccountId">Bestehender Kunde (statt Neuanlage)</label>
                  <select id="existingAccountId" name="existingAccountId" className="select" defaultValue={existing?.id ?? ""}>
                    <option value="">– neuen Kunden anlegen –</option>
                    {d.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div><label className="label" htmlFor="orgName">Name der Organisation (bei Neuanlage)</label><input id="orgName" name="orgName" className="input" defaultValue={p.organization?.name ?? ""} maxLength={200} />{p.organization && quote(p.organization.evidenceQuote)}</div>
                <div>
                  <label className="label" htmlFor="orgType">Organisationstyp</label>
                  <select id="orgType" name="orgType" className="select" defaultValue={p.organization?.orgType ?? "SONSTIGE"}>
                    {schema.orgTypeEnum.enumValues.map((v) => <option key={v} value={v}>{orgTypeLabel[v] ?? v}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="responsibleBdUserId">Zuständiger BD</label>
                  <select id="responsibleBdUserId" name="responsibleBdUserId" className="select" defaultValue={d.bds.some((b) => b.id === actor.userId) ? actor.userId : ""}>
                    <option value="">– ich selbst –</option>
                    {d.bds.map((b) => <option key={b.id} value={b.id}>{b.displayName}</option>)}
                  </select>
                </div>
              </div>
            </section>

            <section className="card">
              <h2 className="font-semibold mb-2">2. Setup (Arbeitszusammenhang)</h2>
              <div className="grid sm:grid-cols-2 gap-3">
                <div><label className="label" htmlFor="setupName">Name des Setups</label><input id="setupName" name="setupName" className="input" required minLength={3} maxLength={200} defaultValue={p.setup?.name ?? (p.organization ? `Erstkontakt ${p.organization.name}` : "")} /></div>
                <div>
                  <label className="label" htmlFor="documentAccessClass">Wer darf das Dokument im Setup sehen?</label>
                  <select id="documentAccessClass" name="documentAccessClass" className="select" defaultValue="SETUP">
                    {schema.accessClassEnum.enumValues.map((v) => <option key={v} value={v}>{accessClassLabel[v]}</option>)}
                  </select>
                </div>
                <div className="sm:col-span-2"><label className="label" htmlFor="contextNote">Was läuft hier? (Kontextnotiz)</label><textarea id="contextNote" name="contextNote" className="textarea" maxLength={2000} defaultValue={p.setup?.contextNote ?? ""} /></div>
              </div>
            </section>

            <section className="card">
              <h2 className="font-semibold mb-2">3. Ansprechpartner ({p.persons.length} vorgeschlagen)</h2>
              <p className="muted text-sm mb-2">Werden mit Beziehung „Name/Funktion bekannt“ angelegt – kein Kontakt wird behauptet.</p>
              {p.persons.length === 0 && <p className="muted text-sm">Keine Personen im Vorschlag. Personen lassen sich später im Kunden anlegen.</p>}
              <div className="space-y-3">
                {p.persons.map((x, i) => (
                  <div key={i} className="grid sm:grid-cols-[auto_1fr_1fr] gap-2 items-start border-t pt-2">
                    <label className="flex items-center gap-2 text-sm pt-2"><input type="checkbox" name={`persons.${i}.include`} defaultChecked /> übernehmen</label>
                    <div><input name={`persons.${i}.displayName`} className="input" defaultValue={x.displayName} aria-label="Name" maxLength={200} /><input name={`persons.${i}.email`} className="input mt-1" defaultValue={x.email} placeholder="E-Mail (optional)" aria-label="E-Mail" maxLength={200} /></div>
                    <div><input name={`persons.${i}.functionTitle`} className="input" defaultValue={x.functionTitle} placeholder="Funktion" aria-label="Funktion" maxLength={200} /><input name={`persons.${i}.knownResponsibility`} className="input mt-1" defaultValue={x.knownResponsibility} placeholder="Bekannte Zuständigkeit (optional)" aria-label="Zuständigkeit" maxLength={500} /></div>
                    <div className="sm:col-span-3">{quote(x.evidenceQuote)}</div>
                  </div>
                ))}
              </div>
            </section>

            <section className="card">
              <h2 className="font-semibold mb-2">4. Beobachtungen / Signale ({p.signals.length} vorgeschlagen)</h2>
              <p className="muted text-sm mb-2">Entstehen als Hinweis „neu“ mit dem Dokument als Quelle. Beobachtung und Vermutung bleiben getrennt.</p>
              <div className="space-y-3">
                {p.signals.map((x, i) => (
                  <div key={i} className="grid sm:grid-cols-[auto_1fr] gap-2 items-start border-t pt-2">
                    <label className="flex items-center gap-2 text-sm pt-2"><input type="checkbox" name={`signals.${i}.include`} defaultChecked /> übernehmen</label>
                    <div>
                      <textarea name={`signals.${i}.observation`} className="textarea" defaultValue={x.observation} aria-label="Beobachtung" maxLength={2000} rows={2} />
                      <input name={`signals.${i}.relevanceHypothesis`} className="input mt-1" defaultValue={x.relevanceHypothesis} placeholder="Vermutung / mögliche Bedeutung (optional)" aria-label="Vermutung" maxLength={2000} />
                      {quote(x.evidenceQuote)}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="card">
              <h2 className="font-semibold mb-2">5. Mögliche Bedarfe ({p.needs.length} vorgeschlagen)</h2>
              <p className="muted text-sm mb-2">Entstehen im Status „in Klärung“ – nie bestätigt. Beschreibung in Kundensprache.</p>
              <div className="space-y-3">
                {p.needs.map((x, i) => (
                  <div key={i} className="grid sm:grid-cols-[auto_1fr] gap-2 items-start border-t pt-2">
                    <label className="flex items-center gap-2 text-sm pt-2"><input type="checkbox" name={`needs.${i}.include`} defaultChecked /> übernehmen</label>
                    <div>
                      <input name={`needs.${i}.title`} className="input" defaultValue={x.title} aria-label="Titel" maxLength={200} />
                      <textarea name={`needs.${i}.needDescription`} className="textarea mt-1" defaultValue={x.needDescription} aria-label="Bedarf" maxLength={4000} rows={2} />
                      {quote(x.evidenceQuote)}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <div className="flex flex-wrap gap-3 items-center">
              <button className="btn" type="submit">Kunde, Setup und ausgewählte Elemente anlegen</button>
              <span className="muted text-sm">Alles entsteht im ungeprüften Zustand und kann danach im Setup bearbeitet werden.</span>
            </div>
          </form>

          <aside className="space-y-3">
            <section className="card">
              <h2 className="font-semibold mb-2">Dokumenttext</h2>
              <pre className="whitespace-pre-wrap text-xs" style={{ fontFamily: "inherit", maxHeight: "70vh", overflow: "auto" }}>{d.source?.body ?? "(kein Text)"}</pre>
            </section>
            <form action={discardIntakeAction}>
              <input type="hidden" name="proposalId" value={d.proposal.id} />
              <button className="btn btn-secondary" type="submit">Vorschlag verwerfen</button>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}
