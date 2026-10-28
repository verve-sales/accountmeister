import Link from "next/link";

/** Begriffe im Accountmeister (Etappe 41) – eine Quelle für Tooltips und die Hilfe „Begriffe“. */
export const TERMS = {
  KUNDE: "Kunde: die Organisation (z. B. eine Bank). Unter ihr liegen Setups, Personen und Einsätze.",
  SETUP: "Setup: ein Arbeitszusammenhang beim Kunden – ein Team, Bereich oder Vorhaben, in dem wir unterwegs sind. Ein Kunde hat meist mehrere Setups. Nicht für einzelne Bedarfe: die sind Chancen.",
  CHANCE: "Chance: eine mögliche Vermittlung im Setup – Verve-Experte, Freelancer oder Ausschreibung. Sie läuft von „antizipiert“ bis „beauftragt“. Nicht für Aufgaben: die sind Aktionen oder Vorgänge.",
  AKTION: "Aktion: ein vereinbarter nächster Schritt gegenüber dem Kunden (Profile schicken, Termin vereinbaren), mit Frist, im Setup oder an der Chance.",
  VORGANG: "Vorgang: ein interner Auftrag an dich selbst, eine Kollegin oder ein Team (z. B. Sales Operations), mit Annahme, Frist und Rückmeldung.",
} as const;
export type TermKey = keyof typeof TERMS;

/** Kleines „?“ mit Erklärung beim Überfahren; Klick führt zur Hilfe „Begriffe“. */
export function Term({ k }: { k: TermKey }) {
  return (
    <Link href="/hilfe#begriffe" title={TERMS[k]} aria-label={TERMS[k]} className="no-underline" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, borderRadius: 999, border: "1px solid var(--border)", fontSize: 11, lineHeight: 1, marginLeft: 6, verticalAlign: "middle", color: "var(--muted, #666)", fontWeight: 600 }}>
      ?
    </Link>
  );
}
