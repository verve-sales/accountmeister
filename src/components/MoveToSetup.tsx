import { cache } from "react";
import { getCurrentActor } from "@/modules/identity/session";
import { editableSetupOptions } from "@/modules/eingang/service";
import { moveToSetupAction } from "@/app/actions";
import { PendingButton } from "./PendingButton";

/** je Seitenaufruf einmal: bearbeitbare Setups („Kunde · Setup“) */
const options = cache(async () => {
  const actor = await getCurrentActor();
  return actor ? editableSetupOptions(actor) : [];
});

/** „Anderes Setup“: Aufgabe oder Beobachtung ohne Begründung umhängen (e47). */
export async function MoveToSetup({ kind, id, currentSetupId, back }: { kind: "ACTION" | "SIGNAL"; id: string; currentSetupId: string | null; back: string }) {
  const opts = (await options()).filter((o) => o.id !== currentSetupId);
  if (!opts.length) return null;
  return (
    <details className="text-xs">
      <summary className="muted" style={{ cursor: "pointer" }}>Anderes Setup</summary>
      <form action={moveToSetupAction} className="flex flex-wrap gap-1 items-center mt-1">
        <input type="hidden" name="kind" value={kind} /><input type="hidden" name="id" value={id} /><input type="hidden" name="back" value={back} />
        <select name="setupId" className="select" required defaultValue="" aria-label="Richtiges Setup" style={{ width: "18rem" }}>
          <option value="" disabled>Richtiger Kunde · Setup …</option>
          {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <PendingButton className="btn btn-secondary btn-small" busy="Verschiebe …">Verschieben</PendingButton>
      </form>
    </details>
  );
}
