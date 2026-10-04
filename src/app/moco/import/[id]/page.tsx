import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { DomainError } from "@/lib/errors";
import { getImport, importerChoices, type ImportDecisions, type ImportItem } from "@/modules/moco/import";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { fmtDate, fmtDateTime } from "@/lib/labels";
import { mocoApplyImportAction, mocoDiscardImportAction, mocoSaveDecisionsAction } from "../../../actions";

const ACTION_LABEL = { LINK: "verknüpfen", NEW: "neu anlegen", SKIP: "überspringen" } as const;

function ActionSelect({ item, decisions }: { item: ImportItem; decisions: ImportDecisions }) {
  const d = decisions[item.key] ?? {};
  const action = d.action ?? item.proposal;
  const target = d.targetId ?? item.targetId ?? "";
  const linkable = item.candidates.length > 0;
  return (
    <span className="inline-flex flex-wrap gap-1 items-center">
      <select name={`d.${item.key}.action`} className="input" style={{ width: "auto" }} defaultValue={action} aria-label="Entscheidung">
        {linkable && <option value="LINK">{ACTION_LABEL.LINK}</option>}
        <option value="NEW">{ACTION_LABEL.NEW}</option>
        <option value="SKIP">{ACTION_LABEL.SKIP}</option>
      </select>
      {linkable && (
        <select name={`d.${item.key}.targetId`} className="input" style={{ width: "auto", maxWidth: 320 }} defaultValue={target} aria-label="Ziel">
          <option value="">– Ziel wählen –</option>
          {item.candidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      )}
    </span>
  );
}

export default async function MocoImportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let imp;
  try {
    imp = await getImport(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const choices = await importerChoices(actor);
  const items = imp.items;
  const decisions = imp.decisions;
  const by = <T extends ImportItem["type"]>(t: T) => items.filter((i): i is Extract<ImportItem, { type: T }> => i.type === t);
  const persons = by("PERSON");
  const teams = by("TEAM");
  const kunden = by("KUNDE");
  const setups = by("SETUP");
  const einsaetze = by("EINSATZ");
  const result = imp.result as { ok?: string[]; skipped?: string[]; errors?: { key: string; message: string }[]; created?: Record<string, number> } | null;
  const editable = imp.status === "ENTWURF";
  const back = `/moco/import/${id}`;
  const setupName = (key: string) => setups.find((s) => s.key === key)?.name ?? key;
  const kundeName = (mocoId: number) => kunden.find((k) => k.mocoId === mocoId)?.name ?? String(mocoId);

  return (
    <div className="space-y-5">
      <p className="text-sm"><Link href="/moco">Moco</Link> · Importlauf</p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Prüfliste Moco-Import</h1>
        <span className="muted text-sm">{imp.summary} · {fmtDateTime(imp.createdAt)} · {imp.status === "ENTWURF" ? "offen" : imp.status === "UEBERNOMMEN" ? `übernommen ${fmtDateTime(imp.appliedAt)}` : "verworfen"}</span>
      </div>
      <Feedback params={sp} />
      {result && (
        <section className="card text-sm">
          <h2 className="font-semibold mb-1">Ergebnis</h2>
          <p>Angelegt: {result.created?.einsaetze ?? 0} Einsätze, {result.created?.setups ?? 0} Setups, {result.created?.kunden ?? 0} Kunden, {result.created?.nutzer ?? 0} Zugänge, {result.created?.freelancer ?? 0} Freelancer, {result.created?.teams ?? 0} Teams; {result.created?.verknuepft ?? 0} Verknüpfungen; {result.skipped?.length ?? 0} übersprungen.</p>
          {!!result.errors?.length && (
            <ul className="mt-2" style={{ color: "#c0392b" }}>
              {result.errors.map((e) => <li key={e.key}>{e.key}: {e.message}</li>)}
            </ul>
          )}
        </section>
      )}
      <form action={editable ? mocoApplyImportAction : mocoSaveDecisionsAction} className="space-y-5">
        <input type="hidden" name="importId" value={id} />
        <input type="hidden" name="back" value={back} />
        <p className="text-sm muted">Regel: Moco führt Namen und Stammdaten (verknüpfte Kunden und Setups bekommen den Moco-Namen). Sales-Rollen kommen nicht aus Moco – BD und Principal setzt du je Setup. Einsätze aus laufenden Zuweisungen werden sofort „aktiv“; Freelancer-Einsätze bekommen Check-ins mit Kunde und Freelancer alle sechs Wochen, interne nicht.</p>

        <section className="card">
          <h2 className="font-semibold mb-2">Kunden ({kunden.length})</h2>
          <ul className="space-y-1 text-sm">
            {kunden.map((k) => (
              <li key={k.key} className="flex flex-wrap items-center gap-2"><strong>{k.name}</strong><span className="muted text-xs">{k.note}</span>{editable ? <ActionSelect item={k} decisions={decisions} /> : <span className="status">{ACTION_LABEL[(decisions[k.key]?.action ?? k.proposal) as keyof typeof ACTION_LABEL]}{k.targetLabel ? ` → ${k.targetLabel}` : ""}</span>}</li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2 className="font-semibold mb-2">Setups aus Projektgruppen ({setups.length})</h2>
          <ul className="space-y-2 text-sm">
            {setups.map((s) => {
              const d = decisions[s.key] ?? {};
              const principalDefault = d.principalUserId ?? (s.principalMocoId ? persons.find((p) => p.mocoId === s.principalMocoId)?.targetId ?? "" : "");
              return (
                <li key={s.key} className="flex flex-wrap items-center gap-2">
                  <strong>{s.name}</strong><span className="muted text-xs">Kunde {kundeName(s.companyMocoId)} · {s.note}</span>
                  {editable ? (
                    <>
                      <ActionSelect item={s} decisions={decisions} />
                      <select name={`d.${s.key}.bdUserId`} className="input" style={{ width: "auto" }} defaultValue={d.bdUserId ?? ""} aria-label="BD"><option value="">BD: offen lassen</option>{choices.bds.map((u) => <option key={u.id} value={u.id}>BD: {u.name}</option>)}</select>
                      <select name={`d.${s.key}.principalUserId`} className="input" style={{ width: "auto" }} defaultValue={principalDefault} aria-label="Principal"><option value="">Principal: keiner</option>{choices.principals.map((u) => <option key={u.id} value={u.id}>Principal: {u.name}</option>)}</select>
                    </>
                  ) : <span className="status">{ACTION_LABEL[(d.action ?? s.proposal) as keyof typeof ACTION_LABEL]}{s.targetLabel ? ` → ${s.targetLabel}` : ""}</span>}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="card">
          <h2 className="font-semibold mb-2">Einsätze aus Zuweisungen ({einsaetze.length})</h2>
          <ul className="space-y-1 text-sm">
            {einsaetze.map((e) => (
              <li key={e.key} className="flex flex-wrap items-center gap-2">
                <strong>{e.projectName}</strong> – {e.personName} <span className="status">{e.personKind === "FREELANCER" ? "Freelancer" : "intern"}</span>
                <span className="muted text-xs">{kundeName(e.companyMocoId)} · Setup {setupName(e.setupKey)} · {e.start ? fmtDate(e.start) : "Start ?"} – {e.end ? fmtDate(e.end) : "offen"}{e.hourlyRate ? ` · ${e.hourlyRate} €/h` : ""} · {e.note}</span>
                {editable ? <ActionSelect item={e} decisions={decisions} /> : <span className="status">{ACTION_LABEL[(decisions[e.key]?.action ?? e.proposal) as keyof typeof ACTION_LABEL]}{e.targetLabel ? ` → ${e.targetLabel}` : ""}</span>}
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2 className="font-semibold mb-2">Personen ({persons.length}) und Teams ({teams.length})</h2>
          <ul className="space-y-1 text-sm">
            {persons.map((p) => (
              <li key={p.key} className="flex flex-wrap items-center gap-2"><strong>{p.name}</strong><span className="status">{p.personKind === "FREELANCER" ? "Freelancer" : p.teamlead ? "Teamleiter → Anker" : "Anker"}</span><span className="muted text-xs">{p.email ?? "ohne E-Mail"}{p.unit ? ` · ${p.unit}` : ""} · {p.note}</span>{editable ? <ActionSelect item={p} decisions={decisions} /> : <span className="status">{ACTION_LABEL[(decisions[p.key]?.action ?? p.proposal) as keyof typeof ACTION_LABEL]}</span>}</li>
            ))}
            {teams.map((t) => (
              <li key={t.key} className="flex flex-wrap items-center gap-2"><strong>{/^team\b/i.test(t.name) ? t.name : `Team ${t.name}`}</strong><span className="muted text-xs">{t.note}</span>{editable ? <ActionSelect item={t} decisions={decisions} /> : <span className="status">{ACTION_LABEL[(decisions[t.key]?.action ?? t.proposal) as keyof typeof ACTION_LABEL]}</span>}</li>
            ))}
          </ul>
          <p className="muted text-xs mt-2">Neue Zugänge erhalten die Rolle Anker; BD, Principal und Sales Operations vergibt die Verwaltung. Teamleiter werden Leitung ihres Teams (Dashboard „Mein Team“), bleiben fachlich Anker.</p>
        </section>

        {editable && (
          <div className="flex flex-wrap gap-3">
            <button className="btn" type="submit">Prüfliste so übernehmen</button>
            <button className="btn btn-secondary" type="submit" formAction={mocoSaveDecisionsAction}>Nur Entscheidungen speichern</button>
            <button className="btn btn-secondary" type="submit" formAction={mocoDiscardImportAction}>Verwerfen</button>
          </div>
        )}
      </form>
    </div>
  );
}
