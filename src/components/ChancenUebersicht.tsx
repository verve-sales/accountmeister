import Link from "next/link";
import { ProcessStepper } from "@/components/ProcessStepper";
import { CHANCE_STEPS, NEXT_CHANCE_STEP } from "@/lib/chanceStages";
import { opportunityStatusLabel } from "@/lib/labels";
import { chanceKindLabel } from "@/modules/ai/schemas";

export type ChanceRow = { id: string; title: string; status: string; kind: string; ownerName: string; setupName?: string | null };

/**
 * „Wo stehen wir?“ auf Setup- und Kundenebene (Etappe 24): eine Zeile je Chance mit eigener Fortschrittsleiste
 * und dem nächsten Schritt als Knopf – statt eines verdichteten Setup-/Kundenstatus.
 */
export function ChancenUebersicht({ chances, emptyText, showSetup = false }: { chances: ChanceRow[]; emptyText: string; showSetup?: boolean }) {
  const all = chances.filter((c) => c.status !== "BEENDET");
  // Beauftragte Chancen sind erledigt – hier ist nichts mehr zu tun; sie stehen eingeklappt darunter (Arbeit läuft unter „Einsätze“)
  const done = all.filter((c) => c.status === "BEAUFTRAGT");
  const open = all.filter((c) => c.status !== "BEAUFTRAGT");
  if (all.length === 0) return <p className="text-sm" style={{ color: "#8a6d1f" }}>{emptyText}</p>;
  const order = (s: string) => (s === "ZURUECKGESTELLT" ? 99 : CHANCE_STEPS.indexOf(s as (typeof CHANCE_STEPS)[number]));
  return (
    <>
    {open.length === 0 && <p className="text-sm muted">Keine Chance in Arbeit – {done.length} beauftragt (unten eingeklappt).</p>}
    <ul className="space-y-3">
      {[...open].sort((a, b) => order(b.status) - order(a.status)).map((c) => {
        const next = NEXT_CHANCE_STEP[c.status];
        const side = c.status === "ZURUECKGESTELLT";
        return (
          <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <div style={{ minWidth: "14rem", flex: "1 1 14rem" }}>
              <Link href={`/bedarfe/${c.id}`} className="font-medium">{c.title}</Link>
              <div className="muted text-xs">{chanceKindLabel[c.kind as keyof typeof chanceKindLabel] ?? c.kind} · verantwortlich {c.ownerName}{showSetup && c.setupName ? ` · ${c.setupName}` : ""}</div>
            </div>
            <ProcessStepper
              steps={CHANCE_STEPS.map((s) => ({ key: s, label: opportunityStatusLabel[s] ?? s }))}
              currentKey={side ? "" : c.status}
              endState={side ? { label: opportunityStatusLabel[c.status] ?? c.status, tone: "warn" } : null}
              variant="compact"
            />
            {next && <Link href={`/bedarfe/${c.id}#${next.anchor}`} className="btn btn-secondary btn-small">{next.label}</Link>}
          </li>
        );
      })}
    </ul>
    {done.length > 0 && (
      <details className="mt-3">
        <summary className="text-sm muted">Beauftragt ({done.length}) – laufende Arbeit siehe <Link href="/einsaetze">Einsätze</Link></summary>
        <ul className="mt-2 text-sm space-y-1">
          {done.map((c) => (
            <li key={c.id} className="flex flex-wrap gap-x-2"><Link href={`/bedarfe/${c.id}`}>{c.title}</Link><span className="muted text-xs">{chanceKindLabel[c.kind as keyof typeof chanceKindLabel] ?? c.kind} · {c.ownerName}{showSetup && c.setupName ? ` · ${c.setupName}` : ""}</span></li>
          ))}
        </ul>
      </details>
    )}
    </>
  );
}
