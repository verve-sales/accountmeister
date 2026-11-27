import type { CaseView } from "@/modules/o2o/service";

type Sys = { moco?: { mode: string; steps: { state: string }[] }; sharepoint?: { state: string }; accountmeister?: { state: string } };

/** Stand je System als drei Punkte mit Beschriftung: erledigt (grün), ausstehend/geplant (gelb), Fehler (rot), aus (grau). */
export function systemStates(c: Pick<CaseView, "systems" | "status">) {
  const s = (c.systems ?? {}) as Sys;
  const am = s.accountmeister?.state ?? (c.status === "ENTWURF" ? "AUSSTEHEND" : "ERLEDIGT");
  const mocoWaits = s.moco?.steps?.some((x) => x.state === "WARTET");
  const sp = s.sharepoint?.state ?? "AUS";
  return [
    { key: "am", label: "Accountmeister", tone: am === "ERLEDIGT" ? "ok" : "warn", text: am === "ERLEDIGT" ? "erledigt" : "ausstehend" },
    { key: "moco", label: "Moco", tone: c.status === "ENTWURF" ? "off" : mocoWaits ? "warn" : "plan", text: c.status === "ENTWURF" ? "–" : mocoWaits ? "wartet auf Angaben" : "geplant (Probelauf)" },
    { key: "sp", label: "SharePoint", tone: sp === "ABGELEGT" ? "ok" : sp === "FEHLER" ? "bad" : "off", text: sp === "ABGELEGT" ? "abgelegt" : sp === "FEHLER" ? "Fehler" : "nicht eingerichtet" },
  ] as const;
}

export function SystemDots({ c }: { c: Pick<CaseView, "systems" | "status"> }) {
  return (
    <span className="sys-dots">
      {systemStates(c).map((x) => (
        <span key={x.key} className="sys-dot" data-tone={x.tone} title={`${x.label}: ${x.text}`} aria-label={`${x.label}: ${x.text}`}>
          {x.label === "Accountmeister" ? "AM" : x.label === "SharePoint" ? "SP" : "Moco"}
        </span>
      ))}
    </span>
  );
}
