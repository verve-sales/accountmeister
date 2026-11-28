import { titleWithoutPerson } from "@/lib/labels";
import Link from "next/link";
import { EinsatzViews } from "@/components/EinsatzViews";
import { Pills, Segmented } from "@/components/ViewSwitch";
import { AsgTimeline } from "@/components/AsgTimeline";
import type { AsgEngagement, AsgState } from "@/modules/assignments/service";
import { pl } from "@/lib/labels";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { getConfig } from "@/lib/config";
import { engagementFilterValues, engagementStatusLabel, listEngagements, type EngagementFilter, type MoodMark } from "@/modules/engagements/service";
import { renewalStatusLabel } from "@/modules/engagements/care";
import { Feedback } from "@/components/Feedback";
import { fmtDate } from "@/lib/labels";
import { isReadOnlyFor } from "@/modules/identity/actor";
import { approachLabel } from "@/modules/engagements/contacts";
import { canClean, findEngagementDuplicates } from "@/modules/cleanup/service";

const FILTERS: { key: EngagementFilter; label: string }[] = [
  { key: "laufend", label: "laufend" },
  { key: "betreuung", label: "meine Betreuung" },
  { key: "enden_8w", label: "enden in 8 Wochen" },
  { key: "checkin_ueberfaellig", label: "Check-in überfällig" },
  { key: "vertrag_offen", label: "Unterlagen offen" },
  { key: "ohne_ansprechpartner", label: "ohne Verlängerungs-Ansprechpartner" },
  { key: "ende_ueberschritten", label: "Ende überschritten" },
  { key: "abgeschlossen", label: "abgeschlossen" },
  { key: "alle", label: "alle" },
];
const RED = "var(--danger)";
const MOOD: Record<MoodMark["mood"], { label: string; color: string }> = { POSITIV: { label: "positiv", color: "#2f7d32" }, MITTEL: { label: "mittel", color: "#b7791f" }, NEGATIV: { label: "negativ", color: RED } };

function Mood({ m, side }: { m: MoodMark | null; side: string }) {
  if (!m) return <span className="muted">{side}: –</span>;
  const c = MOOD[m.mood];
  return <span title={m.note ?? undefined}>{side}: <span style={{ color: c.color, fontWeight: 600 }}>{c.label}</span> <span className="muted">({fmtDate(m.at)})</span></span>;
}

export default async function EinsaetzePage({ searchParams }: { searchParams: Promise<{ fehler?: string; ok?: string; f?: string; q?: string }> }) {
  if (getConfig().FEATURE_BESETZUNG !== "true") notFound();
  const sp = await searchParams;
  const actor = await getCurrentActor();
  const asg = actor ? await (await import("@/modules/assignments/service")).canUseAssignments(actor).catch(() => false) : false;
  if (!actor) redirect("/anmelden");
  const filter = (engagementFilterValues as readonly string[]).includes(sp.f ?? "") ? (sp.f as EngagementFilter) : "laufend";
  const q = (sp.q ?? "").trim();
  const { items, counts } = await listEngagements(actor, filter, q);
  const qs = q ? `&q=${encodeURIComponent(q)}` : "";
  const dups = await findEngagementDuplicates(actor, items);
  const dupIds = new Set(dups.flatMap((g) => [g.keep.id, ...g.drop.map((d) => d.id)]));
  const cleaner = canClean(actor);
  // e79: Zeitleiste auch für BD und Principal – dieselben Einsätze wie in der Liste, nur lesend, ohne Konditionen
  const asTimeline = !asg && (sp as { ansicht?: string }).ansicht === "zeitleiste";
  const todayStr = new Date().toISOString().slice(0, 10);
  const tlItems: AsgEngagement[] = asTimeline ? items.map((e) => {
    const renewing = !!e.renewalStatus && ["IN_ABSTIMMUNG", "ANGEBOTEN", "MOEGLICH"].includes(e.renewalStatus);
    const state: AsgState = ["ABGESCHLOSSEN", "ABGEBROCHEN"].includes(e.status) ? "BEENDET" : e.status === "GEPLANT" ? "GEPLANT" : e.daysToEnd !== null && e.daysToEnd < 0 ? "UEBERSCHRITTEN" : renewing ? "VERLAENGERUNG" : e.daysToEnd !== null && e.daysToEnd <= 28 ? "DRINGEND" : e.daysToEnd !== null && e.daysToEnd <= 56 ? "ENDET_BALD" : "LAEUFT";
    return { id: e.id, personId: e.freelancerId ? `fl:${e.freelancerId}` : `u:${e.internalUserId ?? e.id}`, person: e.personName, kind: e.internalUserId ? "INTERN" : "FREELANCER", accountId: e.accountId, accountName: e.accountName, title: e.title, status: e.status, start: e.actualStart ?? e.plannedStart, end: e.plannedEnd, daysToEnd: e.daysToEnd, state, renewalStatus: e.renewalStatus ?? null, renewalTo: e.renewalTo ?? null, offerNumber: null, orderReference: e.orderReference, mocoProjectId: null, ek: null, vk: null, rateUnit: "TAG", scope: null, contract: null, orderDoc: false, bdName: e.bdName, nextCheckin: null, checkinDots: [] };
  }) : [];
  // e77: betrifft eine Warnung fast alle Zeilen, steht sie einmal über der Tabelle statt orange in jeder Zeile
  const noContact = items.filter((e) => !e.contacts.renewal).length;
  const noContactShare = items.length >= 4 ? noContact / items.length : 0;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Einsätze</h1>
        <span className="muted text-sm">Wer ist wo bis wann – mit Stimmung aus den Check-ins und Stand der Verlängerung. Stundenzettel bleiben in Moco.</span>
        <span className="flex gap-3 ml-auto text-sm">
          {asg && <Link href="/vertragsbuero#erfassen">Von Hand erfassen</Link>}
          <Link href="/auftragseingang" className="btn btn-small">Bestellung hochladen</Link>
        </span>
      </div>
      <EinsatzViews active="liste" asg={!!asg} />
      {!asg && <Segmented label="Ansicht der Einsätze" items={[{ href: `/einsaetze?f=${filter}${qs}`, label: "Liste", active: !asTimeline }, { href: `/einsaetze?f=${filter}${qs}&ansicht=zeitleiste`, label: "Zeitleiste", active: asTimeline }]} />}
      <Feedback params={sp} />
      {noContactShare >= 0.6 && <p className="text-sm muted">Bei {noContact} von {items.length} Einsätzen ist noch kein Ansprechpartner für die Verlängerung hinterlegt – <Link href="/einsaetze?f=ohne_ansprechpartner">nur diese zeigen</Link>.</p>}
      <form method="get" action="/einsaetze" className="flex flex-wrap gap-2 items-center text-sm">
        <input type="hidden" name="f" value={filter} />
        <input name="q" className="input" defaultValue={q} placeholder="Kunde, Person oder Einsatz suchen …" aria-label="Suchen" style={{ width: 360 }} />
        <button className="btn btn-small" type="submit">Suchen</button>
        {q && <Link href={`/einsaetze?f=${filter}`} className="muted text-xs">zurücksetzen</Link>}
      </form>
      <Pills label="Filter" items={FILTERS.map((f) => ({ href: `/einsaetze?f=${f.key}${qs}`, label: f.label, active: filter === f.key, count: counts[f.key] }))} />
      {(counts.ende_ueberschritten > 0 || dups.length > 0) && (
        <p className="text-sm" style={{ color: "#8a5a00" }}>
          {counts.ende_ueberschritten > 0 && <><Link href={`/einsaetze?f=ende_ueberschritten${qs}`}>{pl(counts.ende_ueberschritten, "Einsatz", "Einsätze")} mit überschrittenem Ende</Link> stehen nicht mehr unter „laufend“. </>}
          {dups.length > 0 && <>{pl(dups.length, "mögliche Dublette", "mögliche Dubletten")} in dieser Liste (markiert). </>}
          {cleaner ? <Link href="/bereinigung">In der Bereinigung abschließen bzw. zusammenführen →</Link> : <span className="muted">Abschließen und Zusammenführen machen Sales Operations oder Geschäftsführung in der Bereinigung.</span>}
        </p>
      )}
      {asTimeline && (
        <section className="card" id="zeitleiste">
          <h2 className="font-semibold mb-2">Wer ist wo bis wann</h2>
          <AsgTimeline engagements={tlItems} today={todayStr} />
        </section>
      )}
      <section className="card" hidden={asTimeline}>
        {items.length === 0 ? (<p className="empty">{q ? `Nichts gefunden für „${q}“.` : "Keine Einsätze in diesem Filter. Einsätze entstehen mit der bestätigten Auswahl an einer Position oder aus Moco."}</p>
        ) : (
          <div className="table-wrap"><table className="list text-sm">
            <thead>
              <tr><th>Person · Kunde</th><th>Einsatz</th><th>Ende</th><th>Stimmung</th><th>Verlängerung · über</th><th>Betreuung</th></tr>
            </thead>
            <tbody>
              {items.map((e) => {
                const endSoon = e.daysToEnd !== null && e.daysToEnd <= 30 && e.status === "AKTIV";
                const renewalOpen = !e.renewalStatus || e.renewalStatus === "ZU_KLAEREN";
                return (
                  <tr key={e.id} style={{ borderLeft: `3px solid ${e.checkinOverdue || endSoon ? RED : e.status === "AKTIV" ? "#2f7d32" : "var(--border)"}` }}>
                    <td>
                      <Link href={`/einsaetze/${e.id}`}><strong>{e.personName}</strong></Link>{e.internalUserId ? <span className="muted text-xs"> (intern)</span> : null}{dupIds.has(e.id) ? <span className="status" style={{ marginLeft: 6, background: "#fdf2e0", color: "#8a5a00" }} title="gleiche Person beim gleichen Kunden mit überlappender Laufzeit">Dublette?</span> : null}{e.overdue ? <span className="status" style={{ marginLeft: 6, background: "#fdecea", color: RED }}>Ende überschritten</span> : null}
                      <div className="muted text-xs">{e.accountName} · BD {e.bdName}</div>
                    </td>
                    <td>
                      <div>{titleWithoutPerson(e.title, e.personName)}</div>
                      <div className="muted text-xs"><span className="status">{engagementStatusLabel[e.status] ?? e.status}</span>{e.mocoProjectId ? ` · Moco ${e.mocoProjectId}` : ""}{e.procurement.complete === false && !e.procurementException ? <span style={{ color: "#b7791f" }}> · Unterlagen {e.procurement.required.filter((r) => r.ok).length}/{e.procurement.required.length}</span> : null}</div>
                    </td>
                    <td style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                      {e.plannedEnd ? <>{fmtDate(e.plannedEnd)}<div className={`text-xs ${endSoon ? "" : "muted"}`} style={endSoon ? { color: RED, fontWeight: 600 } : undefined}>{e.daysToEnd !== null ? `${e.daysToEnd} Tage` : ""}</div></> : <span className="muted">offen</span>}
                    </td>
                    <td className="text-xs">
                      <div><Mood m={e.moodKunde} side="Kunde" /></div>
                      {e.freelancerId ? <div><Mood m={e.moodFreelancer} side="Freelancer" /></div> : null}
                      {e.nextCheckin && <div style={e.checkinOverdue ? { color: RED, fontWeight: 600 } : undefined} className={e.checkinOverdue ? "" : "muted"}>nächster {fmtDate(e.nextCheckin)}{e.checkinOverdue ? " (überfällig)" : ""}</div>}
                    </td>
                    <td className="text-xs">
                      {e.renewalStatus ? <>{renewalStatusLabel[e.renewalStatus] ?? e.renewalStatus}{e.renewalTo && e.renewalStatus !== "ZU_KLAEREN" ? <> bis {fmtDate(e.renewalTo)}</> : null}</> : <span className="muted">–</span>}
                      <div>{e.contacts.renewal ? <span title={[e.contacts.renewal.role, e.contacts.renewal.email, e.contacts.renewal.phone].filter(Boolean).join(" · ") || undefined}>{e.contacts.renewal.name}</span> : <span className={noContactShare >= 0.6 ? "muted" : undefined} style={noContactShare >= 0.6 ? undefined : { color: "#b7791f" }}>Ansprechpartner offen</span>}{e.contacts.approach ? <span className="muted"> · spricht an: {approachLabel[e.contacts.approach]}</span> : null}</div>
                      {renewalOpen && !isReadOnlyFor(actor, e.accountId) && ["AKTIV", "PAUSIERT", "GEPLANT", "ENDET"].includes(e.status) && <div className="mt-1"><Link href={`/einsaetze/${e.id}#verlaengerung`} className="btn btn-small btn-quiet">Verlängerung anstoßen</Link></div>}
                    </td>
                    <td className="text-xs">{e.careNames.length ? e.careNames.map((n) => n.replace(/ \((Kundenbetreuung|Freelancer-Betreuung)\)$/, "")).join(", ") : <span style={{ color: "#b7791f" }}>offen</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
