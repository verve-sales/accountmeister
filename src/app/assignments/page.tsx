import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { asgOpportunities, asgOverview, asgTaskLabel, canUseAssignments } from "@/modules/assignments/service";
import { AsgTimeline } from "@/components/AsgTimeline";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { fmtDate } from "@/lib/labels";
import { mocoSyncNowAction } from "@/app/actions";
import { mocoEnabled } from "@/modules/moco/client";
import { canRunMocoImport } from "@/modules/moco/import";
import { PendingButton } from "@/components/PendingButton";
import { canClean, findEngagementDuplicates, findFreelancerDuplicates } from "@/modules/cleanup/service";

const RED = "#c0392b";

export default async function AssignmentsPage({ searchParams }: { searchParams: SearchParams & Promise<{ wer?: string; chancen?: string }> }) {
  const params = (await searchParams) as { wer?: string; chancen?: string } & Awaited<SearchParams>;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!(await canUseAssignments(actor))) redirect("/start");
  const o = await asgOverview(actor);
  const wer = params.wer === "freelancer" || params.wer === "intern" ? params.wer : "alle";
  const shown = o.engagements.filter((e) => wer === "alle" || (wer === "freelancer" ? e.kind === "FREELANCER" : e.kind === "INTERN"));
  const k = o.kpis;
  // e55: Chancen einblenden (Umschalter über der Zeitleiste)
  const withOpps = params.chancen === "1";
  const oppData = withOpps ? await asgOpportunities(actor, o.engagements) : { items: [], withoutPerson: 0 };
  const shownOpps = oppData.items.filter((x) => wer === "alle" || (wer === "freelancer" ? x.kind === "FREELANCER" : x.kind === "INTERN"));
  const q = (w: string, c: boolean) => { const sp = new URLSearchParams(); if (w !== "alle") sp.set("wer", w); if (c) sp.set("chancen", "1"); const t = sp.toString(); return `/assignments${t ? `?${t}` : ""}#zeitleiste`; };
  const noEnd = shown.filter((e) => !e.end).length;
  const canPull = mocoEnabled() && canRunMocoImport(actor);
  const [flDup, engDup] = canClean(actor) ? await Promise.all([findFreelancerDuplicates(actor), findEngagementDuplicates(actor)]) : [[], []];
  const tiles: { v: number; l: string; href: string; warn?: boolean }[] = [
    { v: k.freelancer, l: "Freelancer im Einsatz", href: "/assignments?wer=freelancer#zeitleiste" },
    { v: k.intern, l: "Interne im Einsatz", href: "/assignments?wer=intern#zeitleiste" },
    { v: k.ending, l: "enden in 8 Wochen, offen", href: "#aufgaben", warn: k.ending > 0 },
    { v: k.renewals, l: "Verlängerungen in Arbeit", href: "#aufgaben" },
    { v: k.ordersOpen, l: "Bestellnummer fehlt", href: "#aufgaben", warn: k.ordersOpen > 0 },
    { v: k.contractsOpen, l: "Freelancer-Vertrag offen", href: "#aufgaben", warn: k.contractsOpen > 0 },
    { v: k.handovers, l: "Übergaben offen", href: "/uebergaben", warn: k.handovers > 0 },
    { v: k.checkinsOverdue, l: "Check-ins überfällig", href: "/assignments/checkins", warn: k.checkinsOverdue > 0 },
  ];
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Übersicht</h1>
      <Feedback params={params} />
      {(flDup.length > 0 || engDup.length > 0) && (
        <p className="card text-sm" style={{ borderLeft: `3px solid ${RED}` }}>
          Dubletten gefunden: {flDup.length > 0 && <>{flDup.length} doppelte Freelancer ({flDup.slice(0, 3).map((g) => g.name).join(", ")}{flDup.length > 3 ? " …" : ""})</>}{flDup.length > 0 && engDup.length > 0 && " · "}{engDup.length > 0 && <>{engDup.length} doppelte Einsätze</>}{" "}
          <Link href={flDup.length ? "/bereinigung#freelancer" : "/bereinigung#einsaetze"}>in der Bereinigung zusammenführen →</Link>
        </p>
      )}
      <section className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3" aria-label="Kennzahlen">
        {tiles.map((t) => (
          <Link key={t.l} href={t.href} className="no-underline p-3" style={{ background: "var(--surface-2)", borderRadius: 8, display: "block", color: "var(--text)" }}>
            <div className="text-2xl font-semibold" style={{ fontVariantNumeric: "tabular-nums", color: t.warn ? RED : undefined }}>{t.v}</div>
            <div className="muted text-xs">{t.l}</div>
          </Link>
        ))}
      </section>

      <section className="card" id="zeitleiste">
        <div className="flex flex-wrap items-baseline gap-3 mb-2">
          <h2 className="font-semibold">Wer ist wo bis wann</h2>
          <span className="text-sm flex gap-3">
            {[["alle", "alle"], ["freelancer", "Freelancer"], ["intern", "Interne"]].map(([v, l]) => <Link key={v} href={q(v!, withOpps)} style={wer === v ? { fontWeight: 700, textDecoration: "underline" } : undefined}>{l}</Link>)}
          </span>
          <Link href={q(wer, !withOpps)} className="text-sm" style={withOpps ? { fontWeight: 700 } : undefined}>{withOpps ? "☑" : "☐"} Chancen einblenden</Link>
          <Link href="/assignments/konditionen" className="text-sm ml-auto">als Tabelle mit Konditionen</Link>
        </div>
        {(noEnd > 0 || canPull) && (
          <div className="flex flex-wrap items-center gap-3 mb-2 text-sm">
            {noEnd > 0 && <span className="muted">{noEnd} ohne Enddatum{canPull ? " – das Projektende aus Moco wird übernommen, sobald es dort gepflegt ist." : ""}</span>}
            {canPull && (
              <form action={mocoSyncNowAction} className="ml-auto">
                <input type="hidden" name="back" value="/assignments#zeitleiste" />
                <input type="hidden" name="full" value="1" />
                <PendingButton busy="Hole Enddaten …" className="btn btn-secondary btn-small">Enddaten aus Moco holen</PendingButton>
              </form>
            )}
          </div>
        )}
        {withOpps && <p className="muted text-xs mb-2">Chancen erscheinen über die Kandidatur einer Person an einer Position – Phase von „vermutet“ (hell) bis „ausgewählt“ (kräftig), rot umrandet bei Überschneidung.{oppData.withoutPerson > 0 ? ` ${oppData.withoutPerson} offene Position${oppData.withoutPerson === 1 ? "" : "en"} noch ohne Person.` : ""}{shownOpps.length === 0 ? " Derzeit keine Chance mit benannter Person." : ""}</p>}
        <AsgTimeline engagements={shown} opportunities={shownOpps} today={o.today} />
      </section>

      <section className="card" id="aufgaben">
        <h2 className="font-semibold">Aufgaben ({o.tasks.length})</h2>
        {o.tasks.length === 0 ? <p className="muted text-sm mt-1">Nichts offen.</p> : (
          <table className="list text-sm mt-1">
            <thead><tr><th>Was</th><th>Person</th><th>Kunde</th><th>Aufgabe</th><th>Fällig</th></tr></thead>
            <tbody>
              {o.tasks.map((t) => (
                <tr key={t.key}>
                  <td><span className="status">{asgTaskLabel[t.kind]}</span></td>
                  <td><strong>{t.person}</strong></td>
                  <td>{t.accountName}</td>
                  <td><Link href={t.href}>{t.title}</Link><span className="muted"> · {t.detail}</span></td>
                  <td style={{ whiteSpace: "nowrap", color: t.overdue ? RED : undefined, fontWeight: t.overdue ? 600 : undefined }}>{t.due ? fmtDate(t.due) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted text-xs mt-2">Die Liste entsteht aus dem Stand der Einsätze: Verlängerungen, fehlende Bestellnummern und Verträge, offene Übergaben, überfällige Freelancer-Check-ins. Erledigt ist eine Zeile, sobald der Stand stimmt.</p>
      </section>
    </div>
  );
}
