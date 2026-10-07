import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { canBrowsePortfolio, portfolioAccount } from "@/modules/portfolio/service";
import { DomainError } from "@/lib/errors";
import { HealthBadge } from "@/components/HealthBadge";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { Status } from "@/components/Status";
import { fmtDate, opportunityStatusLabel } from "@/lib/labels";
import { engagementStatusLabel } from "@/modules/engagements/service";
import { renewalStatusLabel } from "@/modules/engagements/care";
import { workStatusLabel } from "@/modules/work/service";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { portfolioDecisionAction } from "../../actions";

const RED = "#c0392b";

export default async function MeineBdsKundePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!canBrowsePortfolio(actor)) notFound();
  let p;
  try {
    p = await portfolioAccount(actor, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const { row, card } = p;
  const back = `/meine-bds/${id}`;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/meine-bds" className="text-sm">← Meine BDs</Link>
        <span className="muted text-sm">{p.position.index} / {p.position.total}</span>
        <span className="ml-auto flex gap-2 text-sm">
          {p.prev ? <Link href={`/meine-bds/${p.prev.accountId}`} className="btn btn-secondary btn-small">‹ {p.prev.accountName}</Link> : null}
          {p.next ? <Link href={`/meine-bds/${p.next.accountId}`} className="btn btn-secondary btn-small">{p.next.accountName} ›</Link> : null}
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold"><Link href={`/kunden/${id}`}>{row.accountName}</Link></h1>
        <HealthBadge score={row.health.score} level={row.health.level} coverage={row.health.coverage} />
        <span className="muted text-sm">BD {row.bdName}{row.ankerNames.length ? ` · Anker ${row.ankerNames.join(", ")}` : " · kein Anker"}{row.principalNames.length ? ` · Principal ${row.principalNames.join(", ")}` : ""} · letzter Kontakt {row.daysSinceActivity >= 999 ? "nie" : `vor ${row.daysSinceActivity} Tagen`}</span>
      </div>
      <Feedback params={sp} />

      <section className="card">
        <h2 className="font-semibold mb-1">Lage</h2>
        <p className="text-sm"><strong>Nächster großer Schritt:</strong> {row.nextStep}</p>
        {card && card.blockers.length > 0 && <p className="text-sm mt-1" style={{ color: RED }}><strong>Blockiert:</strong> {card.blockers.join(" · ")}</p>}
        {card && card.missing.length > 0 && <p className="text-sm mt-1 muted"><strong>Fehlt:</strong> {card.missing.slice(0, 3).join(" · ")}</p>}
      </section>

      <div className="grid lg:grid-cols-2 gap-4">
        <section className="card">
          <h2 className="font-semibold mb-2">Laufendes Geschäft ({p.engagements.length})</h2>
          {p.engagements.length === 0 ? <p className="muted text-sm">Kein laufender Einsatz.</p> : (
            <ul className="text-sm space-y-1">
              {p.engagements.map((e) => (
                <li key={e.id} className="flex flex-wrap gap-x-2 items-baseline">
                  <Link href={`/einsaetze/${e.id}`}><strong>{e.person}</strong></Link>
                  <span className="muted text-xs">{e.title}</span>
                  <span className="ml-auto text-xs" style={e.daysToEnd !== null && e.daysToEnd <= 30 ? { color: RED, fontWeight: 600 } : undefined}>{e.plannedEnd ? `bis ${fmtDate(e.plannedEnd)}` : engagementStatusLabel[e.status] ?? e.status}{e.renewal ? ` · ${renewalStatusLabel[e.renewal.status] ?? e.renewal.status}${e.renewal.to && e.renewal.status !== "ZU_KLAEREN" ? ` bis ${fmtDate(e.renewal.to)}` : ""}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2 className="font-semibold mb-2">Neues Geschäft ({p.chances.length})</h2>
          {p.chances.length === 0 ? <p className="muted text-sm">Keine Chance in Arbeit.</p> : (
            <ul className="text-sm space-y-1">
              {p.chances.map((c) => (
                <li key={c.id} className="flex flex-wrap gap-x-2 items-baseline"><Link href={`/bedarfe/${c.id}`}>{c.title}</Link><Status label={opportunityStatusLabel[c.status] ?? c.status} /><span className="muted text-xs ml-auto">{c.ownerName} · {fmtDate(c.updatedAt)}</span></li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card" id="entscheidung">
        <h2 className="font-semibold mb-1">Entscheidung oder Hinweis für den BD</h2>
        <p className="muted text-xs mb-2">Wird ein Vorgang bei {row.bdName}, verknüpft mit dem Kunden – erscheint bei ihm oben auf Start. Du siehst unten, ob er erledigt ist.</p>
        <form action={portfolioDecisionAction} className="flex flex-wrap gap-2 items-end text-sm">
          <input type="hidden" name="accountId" value={id} /><input type="hidden" name="back" value={`${back}#entscheidung`} />
          <div style={{ flex: "1 1 24rem" }}><label className="label" htmlFor="pdText">Text</label><input id="pdText" name="text" className="input" required minLength={3} maxLength={2000} placeholder="z. B. Verlängerung UX bis Freitag mit Frau Knoche klären; VK nicht unter 1.050." /></div>
          <div><label className="label" htmlFor="pdDue">Bis</label><input id="pdDue" type="date" name="dueDate" className="input" defaultValue={plusDaysIso(todayIso(), 7)} /></div>
          <div><label className="label" htmlFor="pdPrio">Priorität</label><select id="pdPrio" name="priority" className="input" defaultValue="NORMAL"><option value="NORMAL">normal</option><option value="HOCH">hoch</option></select></div>
          <button className="btn btn-small" type="submit" disabled={!row.bdUserId}>An {row.bdName}</button>
        </form>
        {p.hints.length > 0 && (
          <ul className="text-xs mt-3 space-y-1">
            {p.hints.map((h) => <li key={h.id}><Link href={`/vorgaenge/${h.id}`}>{h.title}</Link> · {h.assigneeName} · <span className="status">{workStatusLabel[h.status] ?? h.status}</span>{h.dueDate ? ` · bis ${fmtDate(h.dueDate)}` : ""}</li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
