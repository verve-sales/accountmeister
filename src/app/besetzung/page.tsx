import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { getConfig } from "@/lib/config";
import { listPositions, positionFilterValues, type PositionFilter } from "@/modules/staffing/service";
import { canBrowseFreelancerPool } from "@/modules/staffing/authz";
import { Feedback } from "@/components/Feedback";
import { PositionList } from "@/components/Staffing";

const FILTERS: { key: PositionFilter; label: string }[] = [
  { key: "alle", label: "alle" },
  { key: "meine", label: "meine" },
  { key: "team", label: "Team-Eingang" },
  { key: "offen", label: "offen" },
  { key: "pausiert", label: "pausiert" },
  { key: "ueberfaellig", label: "überfällig" },
  { key: "besetzt", label: "besetzt" },
];

export default async function BesetzungenPage({ searchParams }: { searchParams: Promise<{ fehler?: string; ok?: string; f?: string }> }) {
  if (getConfig().FEATURE_BESETZUNG !== "true") notFound();
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const filter = (positionFilterValues as readonly string[]).includes(sp.f ?? "") ? (sp.f as PositionFilter) : "alle";
  const { items, counts } = await listPositions(actor, filter);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Besetzungen</h1>
        <span className="muted text-sm">Positionen an Chancen: Bedarf → Suche (Sales Operations) → Kandidaten → Vorstellung → Auswahl.</span>
        {canBrowseFreelancerPool(actor) && <Link href="/besetzung/freelancer" className="text-sm ml-auto">Freelancer-Pool</Link>}
      </div>
      <Feedback params={sp} />
      <nav aria-label="Filter" className="flex flex-wrap gap-2 text-sm">
        {FILTERS.map((f) => (
          <Link key={f.key} href={`/besetzung?f=${f.key}`} className={`btn btn-small${filter === f.key ? "" : " btn-secondary"}`} aria-current={filter === f.key ? "page" : undefined}>
            {f.label} ({counts[f.key]})
          </Link>
        ))}
      </nav>
      <section className="card">
        <PositionList items={items} empty={filter === "alle" ? "Keine Positionen im Sichtbereich. Positionen entstehen an einer Chance (Block „Besetzung“)." : "Nichts in diesem Filter."} />
      </section>
      <p className="muted text-xs">Sichtbar sind Positionen deiner Kunden (BD-Kontext, Principal, CEO) sowie – nach Übernahme eines Suchauftrags – die Positionen, die du bearbeitest. Im Team-Eingang stehen offene Suchaufträge nur als Vorschau.</p>
    </div>
  );
}
