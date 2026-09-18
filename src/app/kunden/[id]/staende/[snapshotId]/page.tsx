import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { getAccountPlanSnapshot } from "@/modules/accountplan/service";
import { AccountPlanView } from "@/components/AccountPlanView";
import { fmtDateTime } from "@/lib/labels";

export default async function StandPage({ params }: { params: Promise<{ id: string; snapshotId: string }> }) {
  const { id, snapshotId } = await params;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  let snap;
  try {
    snap = await getAccountPlanSnapshot(actor, snapshotId);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  return (
    <div className="space-y-4">
      <p className="text-sm"><Link href="/kunden">Kunden</Link> › <Link href={`/kunden/${id}`}>{snap.content.account.name}</Link> › Gespeicherter Stand</p>
      <h1 className="text-2xl font-semibold">{snap.title}</h1>
      <p className="muted text-sm">Gespeichert von {snap.confirmedByName} am {fmtDateTime(snap.confirmedAt)}.{snap.note && ` Notiz: ${snap.note}`} Dieser Stand bleibt unverändert, auch wenn sich die Live-Übersicht ändert.</p>
      <section className="card"><AccountPlanView plan={snap.content} live={false} /></section>
      <p className="text-sm"><Link href={`/kunden/${id}`}>Zur aktuellen Live-Übersicht</Link></p>
    </div>
  );
}
