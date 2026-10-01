"use client";

import { useState } from "react";
import { createWorkItemAction } from "@/app/actions";

type Field = { key: string; label: string; required: boolean };
type Service = { id: string; name: string; description: string | null; defaultWorkdays: number; fields: Field[] };
type Team = { id: string; name: string; services: Service[] };

/**
 * Vorgang anlegen: eigene Aufgabe, Anfrage an eine Person oder an ein Team (mit Anfrageart).
 * Die Felder der Anfrageart erscheinen erst, wenn ein Team gewählt ist.
 */
export function WorkCreateForm({
  users,
  teams,
  subjectType,
  subjectId,
  back,
  parentId,
  compact,
  idPrefix = "w",
  defaultTarget = "me",
}: {
  users: { id: string; name: string }[];
  teams: Team[];
  subjectType?: string;
  subjectId?: string;
  back: string;
  parentId?: string;
  compact?: boolean;
  idPrefix?: string;
  defaultTarget?: string;
}) {
  const [target, setTarget] = useState(defaultTarget);
  const team = target.startsWith("team:") ? teams.find((t) => t.id === target.slice(5)) : undefined;
  const [serviceId, setServiceId] = useState("");
  const service = team?.services.find((s) => s.id === serviceId);
  const id = (k: string) => `${idPrefix}-${k}`;

  return (
    <form action={createWorkItemAction} className="grid sm:grid-cols-2 gap-3 mt-2">
      <input type="hidden" name="back" value={back} />
      {subjectType && <input type="hidden" name="subjectType" value={subjectType} />}
      {subjectId && <input type="hidden" name="subjectId" value={subjectId} />}
      {parentId && <input type="hidden" name="parentId" value={parentId} />}
      <div className="sm:col-span-2">
        <label className="label" htmlFor={id("title")}>Was ist zu tun?</label>
        <input id={id("title")} name="title" className="input" required minLength={3} maxLength={300} placeholder="z. B. Referenzprojekt für die Ausschreibung heraussuchen" />
      </div>
      <div>
        <label className="label" htmlFor={id("target")}>Wer bearbeitet?</label>
        <select
          id={id("target")}
          name="target"
          className="input"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setServiceId("");
          }}
        >
          <option value="me">Ich selbst (eigene Aufgabe)</option>
          {teams.length > 0 && (
            <optgroup label="Team (Warteschlange)">
              {teams.map((t) => (
                <option key={t.id} value={`team:${t.id}`}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Person (Anfrage)">
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      {team ? (
        <div>
          <label className="label" htmlFor={id("service")}>Anfrageart</label>
          <select id={id("service")} name="serviceTypeId" className="input" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Freie Anfrage</option>
            {team.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.defaultWorkdays} Werktage)
              </option>
            ))}
          </select>
          {service?.description && <p className="muted text-xs mt-1">{service.description}</p>}
        </div>
      ) : (
        <div>
          <label className="label" htmlFor={id("due")}>Bis wann? (optional)</label>
          <input id={id("due")} type="date" name="dueDate" className="input" />
        </div>
      )}
      {service?.fields.map((f) => (
        <div key={f.key}>
          <label className="label" htmlFor={id(`f-${f.key}`)}>
            {f.label}
            {f.required ? " *" : ""}
          </label>
          <input id={id(`f-${f.key}`)} name={`field_${f.key}`} className="input" required={f.required} maxLength={2000} />
        </div>
      ))}
      {team && (
        <div>
          <label className="label" htmlFor={id("due2")}>Bis wann? {service ? `(leer = ${service.defaultWorkdays} Werktage)` : "(optional)"}</label>
          <input id={id("due2")} type="date" name="dueDate" className="input" />
        </div>
      )}
      {!compact && (
        <div className="sm:col-span-2">
          <label className="label" htmlFor={id("desc")}>Kontext (optional)</label>
          <textarea id={id("desc")} name="description" className="input" rows={2} maxLength={4000} placeholder="Was soll herauskommen, was ist schon bekannt, was darf weitergegeben werden?" />
        </div>
      )}
      {!compact && (
        <div>
          <label className="label" htmlFor={id("check")}>Checkliste (optional, je Zeile ein Punkt)</label>
          <textarea id={id("check")} name="checklistText" className="input" rows={2} maxLength={4000} />
        </div>
      )}
      <div className="flex flex-col gap-2 justify-end">
        <label className="text-sm flex items-center gap-2">
          <input type="checkbox" name="priority" value="HOCH" /> dringend
        </label>
        {target !== "me" && !team && (
          <label className="text-sm flex items-center gap-2">
            <input type="checkbox" name="reviewRequired" defaultChecked /> Ergebnis vor Abschluss prüfen
          </label>
        )}
        {team && <span className="muted text-xs">{service ? (service.fields.length ? "Pflichtangaben mit *." : "") : "Ohne Anfrageart: freie Anfrage an das Team."}</span>}
      </div>
      <div className="sm:col-span-2">
        <button className="btn btn-small" type="submit">
          {target === "me" ? "Aufgabe anlegen" : team ? `An ${team.name} senden` : "Anfrage senden"}
        </button>
      </div>
    </form>
  );
}
