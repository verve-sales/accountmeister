import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { getInterview } from "@/modules/interviews/service";
import { interviewTopicLabel } from "@/modules/ai/schemas";
import { getProviderStatus } from "@/modules/suggestions/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { interviewStatusLabel } from "@/lib/labels";
import { answerInterviewAction, discardInterviewAction, finishInterviewAction } from "../../actions";

/**
 * Geführtes Interview: links der Verlauf mit der aktuellen Frage und dem Antwortfeld, rechts die Themenabdeckung.
 * Antworten in eigenen Worten; die Windows-Diktierfunktion (Win + H) tippt direkt ins Feld.
 */
export default async function InterviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let d;
  try {
    d = await getInterview(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const ai = getProviderStatus();
  const running = d.interview.status === "LAUFEND";
  const last = d.turns[d.turns.length - 1];
  const openQuestion = running && last?.role === "KI" ? last : null;
  const answers = d.turns.filter((t) => t.role === "NUTZER").length;
  const coveredCount = d.topics.filter((t) => t.covered).length;
  const back = d.ctx ? `/setups/${d.ctx.setup.id}` : "/kunden";

  return (
    <div className="space-y-6">
      <p className="text-sm">{d.ctx ? <><Link href="/kunden">Kunden</Link> › <Link href={`/kunden/${d.ctx.account.id}`}>{d.ctx.account.name}</Link> › <Link href={`/setups/${d.ctx.setup.id}`}>{d.ctx.setup.name}</Link> › Interview</> : <><Link href="/kunden">Kunden</Link> › Interview neuer Kunde</>}</p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{d.interview.title}</h1>
        <Status label={interviewStatusLabel[d.interview.status] ?? d.interview.status} />
        <span className="muted text-sm">{d.interview.questionCount} von höchstens {d.maxQuestions} Fragen · {answers} Antworten</span>
      </div>
      <Feedback params={sp} />

      <div className="grid lg:grid-cols-[3fr_1fr] gap-6 items-start">
        <div className="space-y-4">
          <section className="card">
            <h2 className="font-semibold mb-2">Verlauf</h2>
            {d.turns.length === 0 && <p className="muted text-sm">Noch keine Frage.</p>}
            <ol className="space-y-3">
              {d.turns.map((t) => (
                <li key={t.id} className={t.role === "KI" ? "" : "pl-6"}>
                  <div className="muted text-xs">{t.role === "KI" ? "Frage" : "Ihre Antwort"}{t.rationale ? ` · ${t.rationale}` : ""}</div>
                  <div className={t.role === "KI" ? "font-medium" : ""} style={{ whiteSpace: "pre-wrap" }}>{t.text}</div>
                </li>
              ))}
            </ol>
          </section>

          {openQuestion && (
            <section className="card">
              <form action={answerInterviewAction} className="grid gap-3">
                <input type="hidden" name="interviewId" value={d.interview.id} />
                <label className="label" htmlFor="text">Ihre Antwort auf: „{openQuestion.text}“</label>
                <textarea id="text" name="text" className="textarea" rows={5} required maxLength={6000} placeholder="In eigenen Worten. Sachverhalte und Vermutungen gern trennen („Ich vermute …“). „Fertig“ beendet das Interview." autoFocus />
                <div className="flex flex-wrap gap-3 items-center">
                  <button className="btn" type="submit">Antwort senden</button>
                  <span className="muted text-sm">Diktieren: Windows-Taste + H im Textfeld. Ihre Antworten werden zur Quelle des Vorschlags.</span>
                </div>
              </form>
            </section>
          )}

          {running && (
            <section className="card">
              <div className="flex flex-wrap gap-3 items-center">
                <form action={finishInterviewAction}>
                  <input type="hidden" name="interviewId" value={d.interview.id} />
                  <button className="btn" type="submit" disabled={answers === 0}>Interview abschließen und auswerten</button>
                </form>
                <form action={discardInterviewAction}>
                  <input type="hidden" name="interviewId" value={d.interview.id} />
                  <input type="hidden" name="back" value={back} />
                  <button className="btn btn-secondary" type="submit">Verwerfen</button>
                </form>
                <span className="muted text-sm">{openQuestion ? "Sie können jederzeit abschließen; unbeantwortete Themen bleiben als offene Punkte." : "Alle Themen sind abgedeckt."}</span>
              </div>
            </section>
          )}

          {!running && d.interview.proposalId && (
            <section className="card">
              <p>Das Interview wurde ausgewertet: <Link href={`/kunden/anlage/${d.interview.proposalId}`}>Zum Anlagevorschlag</Link>{d.interview.sourceId ? <> · <Link href={`/quellen/${d.interview.sourceId}`}>Transkript als Quelle</Link></> : null}</p>
            </section>
          )}
        </div>

        <aside className="space-y-3">
          <section className="card">
            <h2 className="font-semibold mb-2">Themen ({coveredCount}/{d.topics.length})</h2>
            <ul className="text-sm space-y-1">
              {d.topics.map((t) => (
                <li key={t.key} className="flex items-center gap-2"><span aria-hidden>{t.covered ? "●" : "○"}</span><span className={t.covered ? "" : "muted"}>{interviewTopicLabel[t.key]}</span></li>
              ))}
            </ul>
            <p className="muted text-xs mt-3">{ai.enabled ? `Fragen stellt: ${ai.description}` : "KI deaktiviert – feste Fragenfolge."}</p>
          </section>
          {d.ctx && (
            <section className="card text-sm">
              <h2 className="font-semibold mb-1">Bekannter Kontext</h2>
              <p>{d.ctx.account.name} · {d.ctx.setup.name}</p>
              <p className="muted">Bereits Bekanntes wird nicht erneut gefragt; der Vorschlag ergänzt dieses Setup.</p>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
