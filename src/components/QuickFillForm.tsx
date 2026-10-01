"use client";

import { useState } from "react";
import { quickFillAction } from "@/app/actions";

export type QuickFillPerson = { id: string; name: string };

/**
 * Schnellbesetzung: Person steht fest (intern oder Freelancer) → ein Formular, ein Klick:
 * Position (falls neu) + Kandidatur + bestätigte Auswahl + Einsatzakte. Kein Suchauftrag, keine Pipeline.
 * Intern: keine Einkaufskonditionen (VK optional – Moco bleibt der Ort für Abrechnung).
 */
export function QuickFillForm({
  opportunityId,
  positionId,
  back,
  users,
  freelancers,
  defaults,
}: {
  opportunityId: string;
  positionId?: string;
  back: string;
  users: QuickFillPerson[];
  freelancers: QuickFillPerson[];
  defaults?: { resourceKind?: string | null; desiredStart?: string | null; plannedEnd?: string | null; endOpen?: boolean; title?: string | null };
}) {
  const [kind, setKind] = useState<"INTERN" | "FREELANCER">(defaults?.resourceKind === "FREELANCER" ? "FREELANCER" : "INTERN");
  const [known, setKnown] = useState<string>("");
  const id = (s: string) => `qf-${positionId ?? "neu"}-${s}`;
  return (
    <form action={quickFillAction} className="grid sm:grid-cols-4 gap-2 mt-2">
      <input type="hidden" name="opportunityId" value={opportunityId} />
      {positionId && <input type="hidden" name="positionId" value={positionId} />}
      <input type="hidden" name="back" value={back} />
      <fieldset className="sm:col-span-4 flex flex-wrap gap-4 items-center">
        <legend className="label">Wer besetzt?</legend>
        <label className="text-sm flex items-center gap-1"><input type="radio" name="resourceKind" value="INTERN" checked={kind === "INTERN"} onChange={() => setKind("INTERN")} /> intern (Mitarbeiter:in)</label>
        <label className="text-sm flex items-center gap-1"><input type="radio" name="resourceKind" value="FREELANCER" checked={kind === "FREELANCER"} onChange={() => setKind("FREELANCER")} /> Freelancer</label>
      </fieldset>
      {!positionId && (
        <div className="sm:col-span-2">
          <label className="label" htmlFor={id("title")}>Rolle / Titel</label>
          <input id={id("title")} name="title" className="input" required minLength={3} maxLength={200} defaultValue={defaults?.title ?? ""} placeholder="z. B. Testautomatisierer:in" />
        </div>
      )}
      {kind === "INTERN" ? (
        <div className="sm:col-span-2">
          <label className="label" htmlFor={id("user")}>Interne Person</label>
          <select id={id("user")} name="internalUserId" className="input" required defaultValue="">
            <option value="" disabled>bitte wählen</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
      ) : (
        <>
          {freelancers.length > 0 && (
            <div className="sm:col-span-2">
              <label className="label" htmlFor={id("fid")}>Freelancer aus dem Pool</label>
              <select id={id("fid")} name="freelancerId" className="input" value={known} onChange={(e) => setKnown(e.target.value)}>
                <option value="">neu / Name unten eintragen</option>
                {freelancers.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          )}
          {!known && (
            <div className="sm:col-span-2">
              <label className="label" htmlFor={id("name")}>Freelancer: Name</label>
              <input id={id("name")} name="newName" className="input" maxLength={200} placeholder="Vor- und Nachname (bestehender Name wird wiedererkannt)" />
            </div>
          )}
        </>
      )}
      <div><label className="label" htmlFor={id("start")}>Start</label><input id={id("start")} type="date" name="desiredStart" className="input" defaultValue={defaults?.desiredStart ?? ""} /></div>
      <div><label className="label" htmlFor={id("end")}>Ende</label><input id={id("end")} type="date" name="plannedEnd" className="input" defaultValue={defaults?.plannedEnd ?? ""} /></div>
      <label className="text-sm flex items-center gap-2 self-end"><input type="checkbox" name="endOpen" value="on" defaultChecked={defaults?.endOpen ?? false} /> Ende offen</label>
      <div className="grid grid-cols-2 gap-2">
        <div><label className="label" htmlFor={id("scope")}>Umfang</label><input id={id("scope")} type="number" min={0} max={1000} name="scopeAmount" className="input" /></div>
        <div>
          <label className="label" htmlFor={id("unit")}>Einheit</label>
          <select id={id("unit")} name="scopeUnit" className="input" defaultValue="TAGE_PRO_WOCHE"><option value="TAGE_PRO_WOCHE">Tage/Woche</option><option value="STUNDEN_PRO_WOCHE">Std/Woche</option><option value="PROZENT">%</option></select>
        </div>
      </div>
      {kind === "FREELANCER" && <div><label className="label" htmlFor={id("ek")}>EK (Pflicht)</label><input id={id("ek")} name="ekRate" className="input" inputMode="decimal" placeholder="€" required /></div>}
      <div><label className="label" htmlFor={id("vk")}>VK an Kunde {kind === "INTERN" ? "(optional)" : ""}</label><input id={id("vk")} name="vkRate" className="input" inputMode="decimal" placeholder="€" /></div>
      <div><label className="label" htmlFor={id("rate")}>je</label><select id={id("rate")} name="rateUnit" className="input" defaultValue="TAG"><option value="TAG">Tag</option><option value="STUNDE">Stunde</option></select></div>
      <div className={kind === "FREELANCER" ? "sm:col-span-3" : "sm:col-span-4"}><label className="label" htmlFor={id("reason")}>Notiz (optional)</label><input id={id("reason")} name="reason" className="input" maxLength={2000} placeholder="z. B. Kunde hat Person bereits bestätigt" /></div>
      <div className="sm:col-span-4 flex flex-wrap items-center gap-3">
        <button className="btn btn-small" type="submit">Besetzen und Einsatz anlegen</button>
        <span className="muted text-xs">Position wird „besetzt“, ein offener Suchauftrag erledigt, die Einsatzakte angelegt. {kind === "INTERN" ? "Intern: keine Einkaufskonditionen, Abrechnung in Moco." : "Konditionen landen als Plan-Periode in der Einsatzakte."}</span>
      </div>
    </form>
  );
}
