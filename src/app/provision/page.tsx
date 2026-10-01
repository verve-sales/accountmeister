import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { ProvisionCalculator } from "@/components/ProvisionCalculator";
import { provisionAccess } from "@/modules/provision/access";

/** Provisionsrechner für Anker, BDs und Principals (zum freien Ausfüllen, ohne Speicherung). */
export default async function Page() {
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const access = provisionAccess(actor);
  if (!access.allowed) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Provisionsrechner</h1>
        <p className="muted">Der Provisionsrechner steht Ankern, BDs und Principals zur Verfügung.</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Provisionsrechner</h1>
      <p className="muted text-sm">Provision auf die Marge vermittelter Kolleg:innen oder Freelancer. Für interne Rollen ist der EK fest hinterlegt, für Freelancer trägst du ihn selbst ein; VK, Einsatztage und deinen Anteil an den Fees erfasst du frei.</p>
      <ProvisionCalculator isPrincipal={access.principal} />
    </div>
  );
}
