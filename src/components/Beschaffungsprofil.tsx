import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { Actor } from "@/modules/identity/actor";
import { docSideLabel, docTypeLabel, docTypeValues } from "@/modules/engagements/service";
import { isStaffingManager } from "@/modules/staffing/authz";
import type { AccountRow } from "@/modules/identity/authz";
import { saveProcurementProfileAction } from "@/app/actions";
import { fmtDateTime } from "@/lib/labels";

/** Beschaffungsprofil des Kunden (Etappe 29): welche Unterlagen vor „geplant“ unterschrieben vorliegen müssen. */
export async function Beschaffungsprofil({ actor, account, back }: { actor: Actor; account: AccountRow; back: string }) {
  const profile = await db.query.procurementProfiles.findFirst({ where: eq(schema.procurementProfiles.accountId, account.id) });
  const manage = isStaffingManager(actor, account, null);
  const required = (profile?.required as { side: string; docType: string }[] | undefined) ?? [];
  if (!manage && !profile) return null;
  const has = (side: string, t: string) => required.some((r) => r.side === side && r.docType === t);
  return (
    <section className="card" id="beschaffungsprofil">
      <div className="flex flex-wrap items-baseline gap-2 mb-1">
        <h2 className="font-semibold">Beschaffungsprofil (Einsätze)</h2>
        <span className="status">{profile?.approvedAt ? "freigegeben" : profile ? "Entwurf" : "fehlt"}</span>
        <span className="muted text-xs">Legt fest, welche Unterlagen je Vertragsseite unterschrieben vorliegen müssen, bevor ein Einsatz „geplant“ ist. Ohne freigegebenes Profil gilt die Vertragslage als unbestimmt.</span>
      </div>
      {required.length > 0 && <p className="text-sm">Pflicht: {required.map((r) => `${docSideLabel[r.side]} – ${docTypeLabel[r.docType]}`).join(", ")}{profile?.approvedAt ? ` · freigegeben ${fmtDateTime(profile.approvedAt)}` : ""}{profile?.note ? ` · ${profile.note}` : ""}</p>}
      {manage && account.status !== "ARCHIVED" && (
        <details className="mt-2">
          <summary>Profil pflegen</summary>
          <form action={saveProcurementProfileAction} className="mt-2 space-y-2 text-sm">
            <input type="hidden" name="accountId" value={account.id} /><input type="hidden" name="back" value={`${back}#beschaffungsprofil`} />
            <div className="grid sm:grid-cols-2 gap-4">
              {(["KUNDE", "FREELANCER"] as const).map((side) => (
                <fieldset key={side} className="border rounded-md p-2" style={{ borderColor: "var(--border)" }}>
                  <legend className="label">{docSideLabel[side]}</legend>
                  {docTypeValues.map((t) => (
                    <label key={t} className="flex items-center gap-2"><input type="checkbox" name={`req_${side}_${t}`} value="on" defaultChecked={has(side, t)} /> {docTypeLabel[t]}</label>
                  ))}
                </fieldset>
              ))}
            </div>
            <div><label className="label" htmlFor="bp-note">Hinweis (z. B. Portal, Besonderheiten)</label><input id="bp-note" name="note" className="input" defaultValue={profile?.note ?? ""} /></div>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-secondary btn-small" type="submit">Speichern</button>
              <button className="btn btn-small" type="submit" name="approve" value="on">Speichern und freigeben</button>
            </div>
          </form>
        </details>
      )}
    </section>
  );
}
