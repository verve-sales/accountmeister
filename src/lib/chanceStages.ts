/**
 * Reifegradkette einer Chance (9.1) – zentral, damit Chance-, Setup-, Kunden- und Startseite dieselben Stufen
 * zeigen. Der Status gehört immer zu einer Chance; Setup und Kunde zeigen je Chance eine Zeile, nie einen
 * verdichteten „Kundenstatus“ (F02).
 */
export const CHANCE_STEPS = ["ANTIZIPIERT", "IN_KLAERUNG", "BESTAETIGT", "PROFIL_ANGEBOT_VORGESTELLT", "AUSWAHL_BESTELLUNG", "BEAUFTRAGT"] as const;

/** Nächster Schritt je Status – als Knopftext, Anker auf der Chance-Seite. */
export const NEXT_CHANCE_STEP: Record<string, { label: string; anchor: string } | null> = {
  ANTIZIPIERT: { label: "In Klärung nehmen", anchor: "chance" },
  IN_KLAERUNG: { label: "Bestätigung festhalten", anchor: "chance" },
  BESTAETIGT: { label: "Profil/Angebot vorstellen", anchor: "angebote" },
  PROFIL_ANGEBOT_VORGESTELLT: { label: "Rückmeldung festhalten", anchor: "angebote" },
  AUSWAHL_BESTELLUNG: { label: "Beauftragung festhalten", anchor: "auftrag" },
  BEAUFTRAGT: null,
  ZURUECKGESTELLT: { label: "Wieder aufnehmen prüfen", anchor: "chance" },
  BEENDET: null,
};
