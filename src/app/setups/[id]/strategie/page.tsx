import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { getStrategy, proposeStrategy, ruleBasedProposal, type StrategyMove } from "@/modules/strategy/service";
import type { StrategyProposal } from "@/modules/ai/schemas";
import { Feedback } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { SetupTabs } from "@/components/SetupTabs";
import { fmtDate } from "@/lib/labels";
import { saveStrategyAction } from "../../../actions";

/**
 * Strategiefaden je Setup (E-044): Lage (regelbasiert), letzte Fassung, neue Fassung erfassen – wahlweise mit
 * KI-Vorschlag (?vorschlag=1), der hier nur vorbelegt und erst durch Speichern zur Fassung wird.
 */
export default async function StrategiePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fehler?: string; ok?: string; vorschlag?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let s;
  try {
    s = await getStrategy(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const { analysis: a, latest, versions, canEdit } = s;

  // Vorbelegung: KI-Vorschlag (auf Wunsch), sonst letzte Fassung, sonst regelbasiert
  let draft: StrategyProposal;
  let draftNote = "";
  let aiJobId: string | null = null;
  let proposalError: string | null = null;
  if (sp.vorschlag && canEdit) {
    try {
      const p = await proposeStrategy(actor, id);
      draft = p.proposal;
      draftNote = p.note || "KI-Vorschlag – jede Zeile prüfen, ändern oder entfernen; gespeichert wird erst mit „Fassung speichern“.";
      aiJobId = p.aiJobId;
    } catch (e) {
      proposalError = e instanceof DomainError ? e.message : "Der KI-Vorschlag ist gerade nicht möglich.";
      draft = latest ? fromRow(latest) : ruleBasedProposal(a);
    }
  } else if (latest) {
    draft = fromRow(latest);
    draftNote = `Vorbelegt mit Fassung ${latest.versionNo} vom ${fmtDate(latest.createdAt)}.`;
  } else {
    draft = ruleBasedProposal(a);
    draftNote = "Noch keine Fassung – regelbasierter Entwurf aus der Lageanalyse.";
  }
  const moves = [...draft.moves, ...Array.from({ length: Math.max(0, 5 - draft.moves.length) }, () => ({ title: "", why: "", ownerRole: "BD" as const, evidenceQuote: "" }))].slice(0, 8);
  const risks = [...draft.risks, ...Array.from({ length: Math.max(0, 3 - draft.risks.length) }, () => ({ text: "", evidenceQuote: "" }))].slice(0, 6);
  const questions = [...draft.openQuestions, ...Array.from({ length: Math.max(0, 3 - draft.openQuestions.length) }, () => "")].slice(0, 6);

  return (
    <div className="space-y-6">
      <p className="text-sm"><Link href="/kunden">Kunden</Link> › <Link href={`/kunden/${a.accountId}`}>{a.accountName}</Link> › <Link href={`/setups/${id}`}>{a.setupName}</Link> › Strategiefaden</p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Strategiefaden „{a.setupName}“</h1>
        <Status label={a.stageLabel} />
      </div>
      <SetupTabs setupId={id} active="strategie" />
      <Feedback params={sp} />
      {proposalError && <p className="error text-sm" role="alert">{proposalError}</p>}

      <section className="card">
        <h2 className="font-semibold mb-2">Lage (regelbasiert, aus dem, was dokumentiert ist)</h2>
        <p className="text-sm"><span className="muted">Nächster großer Schritt: </span>{a.nextStep}</p>
        <div className="grid sm:grid-cols-3 gap-4 mt-3 text-sm">
          <div><div className="font-medium mb-1">Blockiert</div>{a.blockers.length === 0 ? <p className="muted">Nichts Dokumentiertes.</p> : <ul className="space-y-1">{a.blockers.map((b, i) => <li key={i} style={{ color: "#a12b1e" }}>{b}</li>)}</ul>}</div>
          <div><div className="font-medium mb-1">Was fehlt</div>{a.missing.length === 0 ? <p className="muted">Grundlagen vollständig.</p> : <ul className="space-y-1">{a.missing.map((m, i) => <li key={i}>{m}</li>)}</ul>}</div>
          <div><div className="font-medium mb-1">Naheliegende Züge</div>{a.moves.length === 0 ? <p className="muted">Nichts vorbereitet.</p> : <ul className="space-y-1">{a.moves.map((m, i) => <li key={i}><Link href={m.href}>{m.text}</Link></li>)}</ul>}</div>
        </div>
        <p className="muted text-xs mt-3">Chancen: {a.opportunities.length ? a.opportunities.map((o) => `${o.title} (${o.status}, ${o.ageDays} Tage)`).join("; ") : "keine"} · {a.counts.persons} Person(en) · {a.counts.openActions} offene Aktion(en) · letztes bestätigtes Weekly {a.weekly.daysSince === null ? "keins" : `vor ${a.weekly.daysSince} Tagen`}</p>
      </section>

      {latest && (
        <section className="card">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="font-semibold">Aktuelle Fassung {latest.versionNo}</h2>
            <span className="muted text-sm">vom {fmtDate(latest.createdAt)} · Stufe damals: {latest.stage}{latest.aiJobId ? " · mit KI-Vorschlag" : ""}</span>
          </div>
          <p className="text-sm mt-2" style={{ whiteSpace: "pre-wrap" }}>{latest.summary}</p>
          <p className="text-sm mt-2"><span className="muted">Nächster großer Schritt: </span>{latest.nextStep}</p>
          {(latest.moves as StrategyMove[]).length > 0 && (
            <ol className="text-sm mt-2 space-y-1 list-decimal ml-5">
              {(latest.moves as StrategyMove[]).map((m, i) => (
                <li key={i}><strong>{m.title}</strong> <span className="status">{m.ownerRole}</span>{m.why && <span className="muted"> – {m.why}</span>}</li>
              ))}
            </ol>
          )}
          {latest.note && <p className="muted text-xs mt-2">Notiz: {latest.note}</p>}
        </section>
      )}

      {canEdit && (
        <section className="card">
          <div className="flex flex-wrap items-baseline gap-3 mb-2">
            <h2 className="font-semibold">Neue Fassung</h2>
            <span className="muted text-sm">{draftNote}</span>
            {!sp.vorschlag && <Link href={`/setups/${id}/strategie?vorschlag=1`} className="btn btn-secondary btn-small ml-auto">Vorschlag der KI einholen</Link>}
          </div>
          <form action={saveStrategyAction} className="grid gap-4 text-sm">
            <input type="hidden" name="setupId" value={id} />
            {aiJobId && <input type="hidden" name="aiJobId" value={aiJobId} />}
            <div>
              <label className="label" htmlFor="summary">Lage – wo stehen wir (belegt / vermutlich trennen)</label>
              <textarea id="summary" name="summary" className="textarea" required minLength={10} defaultValue={draft.summary} rows={4} />
            </div>
            <div>
              <label className="label" htmlFor="nextStep">Nächster großer Schritt</label>
              <input id="nextStep" name="nextStep" className="input" required minLength={5} defaultValue={draft.nextStep} />
            </div>
            <div>
              <div className="label">Züge (leer lassen = weglassen)</div>
              <div className="space-y-2">
                {moves.map((m, k) => (
                  <div key={k} className="grid sm:grid-cols-12 gap-2 items-start">
                    <input name={`moves.${k}.title`} className="input sm:col-span-5" placeholder={`Zug ${k + 1}`} defaultValue={m.title} maxLength={200} />
                    <input name={`moves.${k}.why`} className="input sm:col-span-4" placeholder="Warum jetzt" defaultValue={m.why} maxLength={600} />
                    <select name={`moves.${k}.ownerRole`} className="select sm:col-span-2" defaultValue={m.ownerRole}>
                      <option value="BD">BD</option><option value="ANKER">Anker</option><option value="PRINCIPAL">Principal</option>
                    </select>
                    <input type="hidden" name={`moves.${k}.evidenceQuote`} value={m.evidenceQuote} />
                    {m.evidenceQuote && <div className="muted text-xs sm:col-span-12">Textstelle: „{m.evidenceQuote.slice(0, 140)}“</div>}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="label">Risiken (belegt)</div>
              <div className="space-y-2">
                {risks.map((r, k) => (
                  <div key={k}>
                    <input name={`risks.${k}.text`} className="input" placeholder={`Risiko ${k + 1}`} defaultValue={r.text} maxLength={400} />
                    <input type="hidden" name={`risks.${k}.evidenceQuote`} value={r.evidenceQuote} />
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="label">Offene Fragen</div>
              <div className="space-y-2">{questions.map((q, k) => <input key={k} name={`openQuestions.${k}.text`} className="input" placeholder={`Frage ${k + 1}`} defaultValue={q} maxLength={300} />)}</div>
            </div>
            <div>
              <label className="label" htmlFor="note">Notiz zur Fassung (optional, z. B. was sich geändert hat)</label>
              <input id="note" name="note" className="input" maxLength={600} />
            </div>
            <div><button className="btn" type="submit">Fassung speichern</button> <span className="muted text-xs ml-2">Es entsteht immer eine neue Version; frühere bleiben nachlesbar.</span></div>
          </form>
        </section>
      )}

      {versions.length > 1 && (
        <details className="card">
          <summary>Frühere Fassungen ({versions.length - 1})</summary>
          <ul className="mt-2 space-y-3 text-sm">
            {versions.slice(1).map((v) => (
              <li key={v.id}>
                <div className="font-medium">Fassung {v.versionNo} · {fmtDate(v.createdAt)} · Stufe {v.stage}</div>
                <p style={{ whiteSpace: "pre-wrap" }}>{v.summary}</p>
                <p className="muted">Nächster Schritt damals: {v.nextStep}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function fromRow(r: { summary: string; nextStep: string; moves: unknown; risks: unknown; openQuestions: unknown }): StrategyProposal {
  return { summary: r.summary, nextStep: r.nextStep, moves: (r.moves as StrategyMove[]).map((m) => ({ title: m.title, why: m.why ?? "", ownerRole: m.ownerRole ?? "BD", evidenceQuote: m.evidenceQuote ?? "" })), risks: (r.risks as { text: string; evidenceQuote: string }[]) ?? [], openQuestions: (r.openQuestions as string[]) ?? [] };
}
