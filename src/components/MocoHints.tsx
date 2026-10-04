import Link from "next/link";
import { mocoHintAction } from "@/app/actions";
import { hintKindLabel, type HintKind } from "@/modules/moco/sync";
import { fmtDateTime } from "@/lib/labels";

export function HintButtons({ id, kind, back = "/moco" }: { id: string; kind: HintKind; back?: string }) {
  const applyLabel: Record<HintKind, string> = { ENDE_GEAENDERT: "Ende übernehmen", PROJEKT_BEENDET: "Einsatz beenden", CONTRACT_INAKTIV: "Einsatz beenden", NEUER_CONTRACT: "Erledigt (per Import übernommen)", NEUES_PROJEKT: "Erledigt (per Import übernommen)", GRUPPE_GEWECHSELT: "In das Setup verschieben", NUTZER_INAKTIV: "Zugang deaktivieren" };
  return (
    <span className="inline-flex gap-1">
      <form action={mocoHintAction} className="inline"><input type="hidden" name="hintId" value={id} /><input type="hidden" name="decision" value="UEBERNEHMEN" /><input type="hidden" name="back" value={back} /><button className="btn btn-small" type="submit">{applyLabel[kind]}</button></form>
      <form action={mocoHintAction} className="inline"><input type="hidden" name="hintId" value={id} /><input type="hidden" name="decision" value="VERWERFEN" /><input type="hidden" name="back" value={back} /><button className="btn btn-secondary btn-small" type="submit">Verwerfen</button></form>
    </span>
  );
}

/** Hinweisblock am Einsatz. */
export function MocoHintList({ hints, back }: { hints: { id: string; kind: string; title: string; createdAt: Date; subjectType: string; subjectId: string | null }[]; back: string }) {
  if (!hints.length) return null;
  return (
    <section className="card" id="moco">
      <h2 className="font-semibold mb-2">Hinweise aus Moco ({hints.length})</h2>
      <ul className="space-y-2 text-sm">
        {hints.map((h) => (
          <li key={h.id} className="flex flex-wrap items-baseline gap-2">
            <span className="status">{hintKindLabel[h.kind as HintKind] ?? h.kind}</span>
            <span>{h.title}</span>
            <span className="muted text-xs">{fmtDateTime(h.createdAt)}</span>
            <HintButtons id={h.id} kind={h.kind as HintKind} back={back} />
          </li>
        ))}
      </ul>
      <p className="muted text-xs mt-2">Moco führt Laufzeit und Zuweisungen. Übernehmen ändert den Einsatz entsprechend; Verwerfen lässt den Stand im Accountmeister unverändert. <Link href="/moco">Alle Hinweise</Link></p>
    </section>
  );
}
