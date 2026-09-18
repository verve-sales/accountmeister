import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { requireSetupContext } from "@/modules/setups/service";
import { canEditSetup, canViewSource } from "@/modules/identity/authz";
import { listOrgUnits, listPeopleForAccount } from "@/modules/people/service";
import { listAccessPlansForSetup } from "@/modules/accesspaths/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { accessClassLabel, accessPlanStatusLabel, fmtDate, readinessLabel, relationshipStateLabel, stepKindLabel } from "@/lib/labels";
import { addAccessPlanStepAction, changeAccessPlanStatusAction, createAccessPlanAction, createPersonAction, setPersonFunctionAction, setRelationshipAction } from "../../../actions";

export default async function PersonenPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let ctx;
  try {
    ctx = await requireSetupContext(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const canEdit = canEditSetup(actor, ctx);
  const back = `/setups/${id}/personen`;
  const [people, plans, units, users, allSources] = await Promise.all([
    listPeopleForAccount(actor, ctx.account.id, id),
    listAccessPlansForSetup(actor, id),
    listOrgUnits(ctx.account.id),
    db.query.users.findMany({ where: eq(schema.users.status, "ACTIVE"), orderBy: (u, { asc }) => [asc(u.displayName)] }),
    db.query.sources.findMany({ where: eq(schema.sources.setupId, id) }),
  ]);
  const sources = allSources.filter((s) => canViewSource(actor, s, ctx));
  const personName = new Map(people.map((p) => [p.person.id, p.person.displayName]));
  const allRelationships = people.flatMap((p) => p.relationships.map((r) => ({ ...r, personName: p.person.displayName })));
  const openPlans = plans.filter((p) => p.status !== "BEENDET");

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/kunden">Kunden</Link> › <Link href={`/kunden/${ctx.account.id}`}>{ctx.account.name}</Link> › <Link href={`/setups/${id}`}>{ctx.setup.name}</Link> › Personen & Zugang
      </p>
      <h1 className="text-2xl font-semibold">Personen & Zugang – {ctx.setup.name}</h1>
      <Feedback params={sp} />
      <p className="muted text-sm">
        Nur berufliche Angaben. Ein Beziehungsstand braucht Kontext und ab „Vorgestellt“ einen Beleg. Eine bekannte Person ist nicht automatisch Sponsor. Kontaktwege trennen belegte, geplante und hypothetische Verbindungen (Briefing 8).
      </p>

      {/* Personen */}
      <section className="card">
        <h2 className="font-semibold mb-2">Personen beim Kunden ({people.length})</h2>
        {people.length === 0 ? <p className="muted text-sm">Noch keine Personen erfasst.</p> : (
          <table className="list">
            <thead><tr><th>Person</th><th>Funktion / Bereich</th><th>Bekannte Zuständigkeit</th><th>Beziehungen in diesem Setup</th><th>Zugriff</th></tr></thead>
            <tbody>
              {people.map(({ person, currentFunction, relationships }) => (
                <tr key={person.id}>
                  <td>{person.displayName}{person.email && <div className="muted text-sm">{person.email}</div>}</td>
                  <td>{currentFunction ? <>{currentFunction.functionTitle}{currentFunction.orgUnitName && <div className="muted text-sm">{currentFunction.orgUnitName}</div>}</> : <span className="muted">unbekannt</span>}</td>
                  <td className="text-sm">{currentFunction?.knownResponsibility ?? <span className="muted">–</span>}</td>
                  <td className="text-sm">
                    {relationships.length === 0 ? <span className="muted">keine dokumentiert</span> : relationships.map((r) => (
                      <div key={r.id} className="mb-1">
                        <Status label={relationshipStateLabel[r.state] ?? r.state} /> {r.holderName}
                        {r.contextNote && <div className="muted">{r.contextNote}</div>}
                        <div className="muted">{r.evidenceSourceId ? (sources.some((s) => s.id === r.evidenceSourceId) ? <Link href={`/quellen/${r.evidenceSourceId}`}>Beleg ansehen</Link> : "Beleg vorhanden (nicht in Ihrem Berechtigungsbereich)") : "kein Beleg"} · Stand {fmtDate(r.updatedAt)}</div>
                      </div>
                    ))}
                  </td>
                  <td className="text-sm">{accessClassLabel[person.accessClass]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canEdit && (
          <div className="mt-4 grid lg:grid-cols-2 gap-6">
            <details>
              <summary>Person anlegen</summary>
              <form action={createPersonAction} className="mt-2 grid sm:grid-cols-2 gap-3">
                <input type="hidden" name="accountId" value={ctx.account.id} />
                <input type="hidden" name="setupId" value={id} />
                <input type="hidden" name="back" value={back} />
                <div><label className="label" htmlFor="pName">Name</label><input id="pName" name="displayName" className="input" required minLength={2} /></div>
                <div><label className="label" htmlFor="pFn">Funktion (falls bekannt)</label><input id="pFn" name="functionTitle" className="input" /></div>
                <div>
                  <label className="label" htmlFor="pUnit">Bereich</label>
                  <select id="pUnit" name="orgUnitId" className="select" defaultValue=""><option value="">– unbekannt –</option>{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
                </div>
                <div><label className="label" htmlFor="pResp">Bekannte Zuständigkeit</label><input id="pResp" name="knownResponsibility" className="input" /></div>
                <div><label className="label" htmlFor="pMail">Berufliche E-Mail (optional)</label><input id="pMail" name="email" type="email" className="input" /></div>
                <div>
                  <label className="label" htmlFor="pAccess">Wer darf die Person sehen?</label>
                  <select id="pAccess" name="accessClass" className="select" defaultValue="ACCOUNT_TEAM">{schema.accessClassEnum.enumValues.filter((v) => v !== "PERSOENLICH").map((v) => <option key={v} value={v}>{accessClassLabel[v]}</option>)}</select>
                </div>
                <div className="sm:col-span-2"><button className="btn" type="submit">Person anlegen</button></div>
              </form>
            </details>
            <details>
              <summary>Beziehungsstand setzen</summary>
              <form action={setRelationshipAction} className="mt-2 grid sm:grid-cols-2 gap-3">
                <input type="hidden" name="setupId" value={id} />
                <input type="hidden" name="back" value={back} />
                <div>
                  <label className="label" htmlFor="rPerson">Person</label>
                  <select id="rPerson" name="personId" className="select" required defaultValue=""><option value="" disabled>Bitte wählen …</option>{people.map((p) => <option key={p.person.id} value={p.person.id}>{p.person.displayName}</option>)}</select>
                </div>
                <div>
                  <label className="label" htmlFor="rHolder">Beziehungshalter (Verve)</label>
                  <select id="rHolder" name="holderUserId" className="select" defaultValue={actor.userId}>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
                </div>
                <div>
                  <label className="label" htmlFor="rState">Stand</label>
                  <select id="rState" name="state" className="select" defaultValue="NAME_FUNKTION_BEKANNT">{schema.relationshipStateEnum.enumValues.map((v) => <option key={v} value={v}>{relationshipStateLabel[v]}</option>)}</select>
                </div>
                <div>
                  <label className="label" htmlFor="rSource">Beleg: vorhandene Quelle</label>
                  <select id="rSource" name="evidenceSourceId" className="select" defaultValue=""><option value="">– keine –</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select>
                </div>
                <div className="sm:col-span-2"><label className="label" htmlFor="rCtx">Kontext (Pflicht)</label><input id="rCtx" name="contextNote" className="input" required minLength={5} placeholder="Woher kennt man sich, worum ging es?" /></div>
                <div className="sm:col-span-2"><label className="label" htmlFor="rEv">Oder Belegnotiz (wird als Quelle gespeichert)</label><input id="rEv" name="evidenceNote" className="input" placeholder="z. B. Mail vom 20.09.: „Ich verbinde Sie gern …“" /></div>
                <div className="sm:col-span-2"><button className="btn" type="submit">Beziehungsstand speichern</button></div>
              </form>
            </details>
            <details>
              <summary>Funktion einer Person ändern</summary>
              <form action={setPersonFunctionAction} className="mt-2 grid sm:grid-cols-2 gap-3">
                <input type="hidden" name="back" value={back} />
                <div>
                  <label className="label" htmlFor="fPerson">Person</label>
                  <select id="fPerson" name="personId" className="select" required defaultValue=""><option value="" disabled>Bitte wählen …</option>{people.map((p) => <option key={p.person.id} value={p.person.id}>{p.person.displayName}</option>)}</select>
                </div>
                <div><label className="label" htmlFor="fTitle">Neue Funktion</label><input id="fTitle" name="functionTitle" className="input" required minLength={2} /></div>
                <div>
                  <label className="label" htmlFor="fUnit">Bereich</label>
                  <select id="fUnit" name="orgUnitId" className="select" defaultValue=""><option value="">– unbekannt –</option>{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
                </div>
                <div><label className="label" htmlFor="fResp">Bekannte Zuständigkeit</label><input id="fResp" name="knownResponsibility" className="input" /></div>
                <div className="sm:col-span-2"><button className="btn btn-secondary" type="submit">Funktion setzen</button></div>
              </form>
            </details>
          </div>
        )}
      </section>

      {/* Kontaktwege */}
      <section className="card">
        <h2 className="font-semibold mb-2">Kontaktwege ({openPlans.length} offen)</h2>
        {plans.length === 0 ? <p className="muted text-sm">Noch kein Kontaktweg. Ein Kontaktweg beschreibt, über welche belegten Beziehungen ein Gespräch mit einer Zielperson legitim zustande kommen kann.</p> : (
          <div className="space-y-4">
            {plans.map((p) => (
              <div key={p.id} className="border rounded-md p-3" style={{ borderColor: "var(--border)" }}>
                <div className="flex flex-wrap gap-2 items-baseline">
                  <strong>Ziel: {p.targetName}</strong>
                  <Status label={accessPlanStatusLabel[p.status] ?? p.status} />
                  <span className="muted text-sm">Verantwortlich: {p.ownerName}</span>
                </div>
                <dl className="text-sm mt-2 grid sm:grid-cols-2 gap-x-6 gap-y-1">
                  <div><dt className="muted">Anlass</dt><dd>{p.occasion}</dd></div>
                  <div><dt className="muted">Angestrebtes Ergebnis</dt><dd>{p.desiredOutcome ?? "–"}</dd></div>
                  <div><dt className="muted">Erlaubter Inhalt der Vorstellung</dt><dd>{p.allowedIntroContent ?? "–"}</dd></div>
                  <div><dt className="muted">Alternative</dt><dd>{p.alternative ?? "–"}</dd></div>
                  <div><dt className="muted">Nächster Schritt</dt><dd>{p.nextStep ?? "–"}</dd></div>
                </dl>
                <table className="list mt-3">
                  <thead><tr><th>#</th><th>Von</th><th>Zu</th><th>Verbindung</th><th>Vermittlungsbereitschaft</th><th>Beleg / Notiz</th></tr></thead>
                  <tbody>
                    {p.steps.length === 0 && <tr><td colSpan={6} className="muted text-sm">Noch keine Schritte.</td></tr>}
                    {p.steps.map((s) => (
                      <tr key={s.id}>
                        <td>{s.position}</td>
                        <td>{s.fromName}</td>
                        <td>{s.toName}</td>
                        <td><Status label={stepKindLabel[s.kind] ?? s.kind} /></td>
                        <td className="text-sm">{readinessLabel[s.mediationReadiness]}</td>
                        <td className="text-sm">
                          {s.kind === "BELEGT" ? (s.evidenceSourceId && sources.some((x) => x.id === s.evidenceSourceId) ? <Link href={`/quellen/${s.evidenceSourceId}`}>Quelle</Link> : "dokumentierte Beziehung") : <span className="muted">{s.kind === "HYPOTHETISCH" ? "angenommen, nicht belegt" : "noch nicht erfolgt"}</span>}
                          {s.note && <div className="muted">{s.note}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {canEdit && p.status !== "BEENDET" && (
                  <div className="mt-3 flex flex-wrap gap-6">
                    <details>
                      <summary className="text-sm">Schritt ergänzen</summary>
                      <form action={addAccessPlanStepAction} className="mt-2 grid sm:grid-cols-3 gap-2 max-w-4xl">
                        <input type="hidden" name="accessPlanId" value={p.id} />
                        <input type="hidden" name="back" value={back} />
                        <div>
                          <label className="label" htmlFor={`fu-${p.id}`}>Von (Verve)</label>
                          <select id={`fu-${p.id}`} name="fromUserId" className="select" defaultValue=""><option value="">–</option>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
                        </div>
                        <div>
                          <label className="label" htmlFor={`fp-${p.id}`}>oder von (Person beim Kunden)</label>
                          <select id={`fp-${p.id}`} name="fromPersonId" className="select" defaultValue=""><option value="">–</option>{people.map((x) => <option key={x.person.id} value={x.person.id}>{x.person.displayName}</option>)}</select>
                        </div>
                        <div>
                          <label className="label" htmlFor={`tp-${p.id}`}>Zu</label>
                          <select id={`tp-${p.id}`} name="toPersonId" className="select" required defaultValue={p.targetPersonId ?? ""}><option value="" disabled>Bitte wählen …</option>{people.map((x) => <option key={x.person.id} value={x.person.id}>{x.person.displayName}</option>)}</select>
                        </div>
                        <div>
                          <label className="label" htmlFor={`k-${p.id}`}>Verbindung</label>
                          <select id={`k-${p.id}`} name="kind" className="select" defaultValue="HYPOTHETISCH">{schema.accessStepKindEnum.enumValues.map((v) => <option key={v} value={v}>{stepKindLabel[v]}</option>)}</select>
                        </div>
                        <div>
                          <label className="label" htmlFor={`rel-${p.id}`}>Beleg: dokumentierte Beziehung</label>
                          <select id={`rel-${p.id}`} name="relationshipId" className="select" defaultValue=""><option value="">–</option>{allRelationships.map((r) => <option key={r.id} value={r.id}>{r.personName} ↔ {r.holderName} ({relationshipStateLabel[r.state]})</option>)}</select>
                        </div>
                        <div>
                          <label className="label" htmlFor={`mr-${p.id}`}>Vermittlungsbereitschaft</label>
                          <select id={`mr-${p.id}`} name="mediationReadiness" className="select" defaultValue="UNBEKANNT">{schema.mediationReadinessEnum.enumValues.map((v) => <option key={v} value={v}>{readinessLabel[v]}</option>)}</select>
                        </div>
                        <div className="sm:col-span-2"><label className="label" htmlFor={`n-${p.id}`}>Notiz</label><input id={`n-${p.id}`} name="note" className="input" /></div>
                        <div className="flex items-end"><button className="btn btn-small" type="submit">Schritt speichern</button></div>
                      </form>
                    </details>
                    <form action={changeAccessPlanStatusAction} className="flex flex-wrap gap-1 items-end">
                      <input type="hidden" name="accessPlanId" value={p.id} />
                      <input type="hidden" name="version" value={p.version} />
                      <input type="hidden" name="back" value={back} />
                      <div>
                        <label className="label" htmlFor={`st-${p.id}`}>Status ändern</label>
                        <select id={`st-${p.id}`} name="status" className="select" defaultValue={p.status}>{schema.accessPlanStatusEnum.enumValues.map((v) => <option key={v} value={v}>{accessPlanStatusLabel[v]}</option>)}</select>
                      </div>
                      <div>
                        <label className="label" htmlFor={`ev-${p.id}`}>Beleg (bei „Vorgestellt“)</label>
                        <select id={`ev-${p.id}`} name="evidenceSourceId" className="select" defaultValue=""><option value="">–</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select>
                      </div>
                      <input name="nextStep" className="input" style={{ width: "14rem" }} placeholder="Nächster Schritt" aria-label="Nächster Schritt" />
                      <button className="btn btn-small" type="submit">Speichern</button>
                    </form>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {canEdit && (
          <details className="mt-4">
            <summary>Kontaktweg anlegen</summary>
            <form action={createAccessPlanAction} className="mt-2 grid sm:grid-cols-2 gap-3">
              <input type="hidden" name="setupId" value={id} />
              <input type="hidden" name="back" value={back} />
              <div>
                <label className="label" htmlFor="apTarget">Zielperson</label>
                <select id="apTarget" name="targetPersonId" className="select" defaultValue=""><option value="">– Person unbekannt, nur Funktion –</option>{people.map((x) => <option key={x.person.id} value={x.person.id}>{x.person.displayName}</option>)}</select>
              </div>
              <div><label className="label" htmlFor="apFn">Gesuchte Funktion (falls Person unbekannt)</label><input id="apFn" name="targetFunction" className="input" placeholder="z. B. wer die Kapazitätsplanung koordiniert" /></div>
              <div className="sm:col-span-2"><label className="label" htmlFor="apOcc">Fachlicher Anlass (Pflicht)</label><input id="apOcc" name="occasion" className="input" required minLength={5} /></div>
              <div><label className="label" htmlFor="apOut">Angestrebtes Gesprächsergebnis</label><input id="apOut" name="desiredOutcome" className="input" /></div>
              <div><label className="label" htmlFor="apAllowed">Erlaubter Inhalt der Vorstellung</label><input id="apAllowed" name="allowedIntroContent" className="input" placeholder="Was darf genannt werden, was bleibt intern?" /></div>
              <div><label className="label" htmlFor="apAlt">Alternative, falls nicht möglich</label><input id="apAlt" name="alternative" className="input" /></div>
              <div>
                <label className="label" htmlFor="apOwner">Verantwortlich</label>
                <select id="apOwner" name="ownerUserId" className="select" defaultValue={actor.userId}>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
              </div>
              <div className="sm:col-span-2"><button className="btn" type="submit">Kontaktweg anlegen</button></div>
            </form>
          </details>
        )}
      </section>
      <p className="muted text-sm">Die grafische Beziehungskarte folgt; die Tabelle ist die gleichwertige Darstellung (Briefing 8.4). {personName.size} Personen bekannt.</p>
    </div>
  );
}
