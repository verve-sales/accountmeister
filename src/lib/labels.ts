/** Deutsche Anzeigetexte für Zustände – Status immer als Text (Briefing 18.1). */
export const signalStatusLabel: Record<string, string> = {
  NEU: "Neu",
  PRUEFUNG_UEBERNOMMEN: "Prüfung übernommen",
  IN_KLAERUNG: "In Klärung",
  MIT_BEDARF_VERKNUEPFT: "Mit Bedarf verknüpft",
  ZURUECKGESTELLT: "Zurückgestellt",
  BEENDET: "Beendet",
};
export const actionStatusLabel: Record<string, string> = {
  VORGESCHLAGEN: "Vorgeschlagen",
  ANGENOMMEN: "Angenommen",
  IN_ARBEIT: "In Arbeit",
  BLOCKIERT: "Blockiert",
  ERLEDIGT: "Erledigt",
  VERWORFEN: "Verworfen",
};
export const handoverStatusLabel: Record<string, string> = {
  ENTWURF: "Entwurf",
  ANGEFRAGT: "Angefragt",
  ANGENOMMEN: "Angenommen",
  ZURUECKGEGEBEN: "Zurückgegeben",
  ABGESCHLOSSEN: "Abgeschlossen",
};
export const setupStatusLabel: Record<string, string> = { ENTWURF: "Entwurf", AKTIV: "Aktiv", RUHEND: "Ruhend", ARCHIVIERT: "Archiviert" };
export const visibilityLabel: Record<string, string> = { MITGLIEDER: "Nur Beteiligte", ACCOUNT_TEAM: "Kundenteam", WORKSPACE: "Gesamter Arbeitsraum" };
export const contributionLabel: Record<string, string> = {
  ANKER_KONTEXT: "Anker – Kontextbeitrag",
  ANKER_RUECKFRAGEN: "Anker – fachliche Rückfragen",
  ANKER_EINFUEHRUNG: "Anker – Einführung möglich",
  BD_ZUSTAENDIG: "BD – zuständig",
  BEOBACHTER: "Beobachter",
};
export const accessClassLabel: Record<string, string> = {
  PERSOENLICH: "Persönlich (nur Quelleninhaber)",
  SETUP: "Setup-Beteiligte",
  ACCOUNT_TEAM: "Kundenteam",
  WORKSPACE: "Arbeitsraum",
};
export const epistemicLabel: Record<string, string> = {
  UNGEPRUEFT_EXTRAHIERT: "Ungeprüft extrahiert",
  AUSSAGE_WIEDERGEGEBEN: "Aussage wiedergegeben",
  SACHVERHALT_BESTAETIGT: "Sachverhalt bestätigt",
  HYPOTHESE: "Hypothese",
  WIDERSPRUECHLICH: "Widersprüchlich",
  UEBERHOLT: "Überholt",
};
export const sourceTypeLabel: Record<string, string> = { NOTIZ: "Notiz", PROTOKOLL: "Protokoll", EMAIL: "E-Mail", TERMIN: "Termin", OEFFENTLICH: "Öffentliche Quelle" };
export const roleLabel: Record<string, string> = { ANKER: "Anker", BD: "BD", PRINCIPAL: "Principal", CEO: "CEO", ADMIN: "Administration" };

export function fmtDate(d: string | Date | null | undefined, tz = "Europe/Berlin"): string {
  if (!d) return "–";
  const date = typeof d === "string" ? (d.length === 10 ? new Date(d + "T00:00:00") : new Date(d)) : d;
  return date.toLocaleDateString("de-DE", { timeZone: typeof d === "string" && d.length === 10 ? undefined : tz });
}
export function fmtDateTime(d: Date | string | null | undefined, tz = "Europe/Berlin"): string {
  if (!d) return "–";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("de-DE", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
}
