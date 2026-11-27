/**
 * Soll-Zustand je System (e67, Konzept Offer-to-Order v2 „Soll statt Ereigniskette“): Aus dem Vorgang wird berechnet,
 * was in Moco und SharePoint stehen muss. Bis der Probelauf mit Moco abgeschlossen ist, werden die Moco-Schritte nur
 * geplant und angezeigt, nicht geschrieben.
 */

export type CaseFacts = {
  channel: "DIREKT" | "VERMITTLER";
  status: string;
  partnerName: string | null;
  endCustomerName: string | null;
  personName: string | null;
  role: string | null;
  startDate: string | null;
  endDate: string | null;
  dailyRate: number | null;
  days: number | null;
  offerNumber: string | null;
  brokerRef: string | null;
  orderNumber: string | null;
  isRenewal: boolean;
  bdName: string | null;
};

export type PlanStep = { system: "MOCO" | "SHAREPOINT"; title: string; detail: string; state: "GEPLANT" | "WARTET" | "ENTFAELLT" };

/** Moco kennt nur Stundensätze: Tagessatz ÷ 8, auf Cent gerundet (R13); Budget in Stunden. */
export function hourlyRate(daily: number | null): number | null {
  return daily == null ? null : Math.round((daily / 8) * 100) / 100;
}

const leadName = (f: CaseFacts, customer: string | null) => [customer ?? f.partnerName ?? "?", f.role ?? "Rolle offen", f.personName ?? "Person offen"].join(" – ");

export function plan(f: CaseFacts): PlanStep[] {
  const steps: PlanStep[] = [];
  const moco = (title: string, detail: string, state: PlanStep["state"] = "GEPLANT") => steps.push({ system: "MOCO", title, detail, state });
  const sp = (title: string, detail: string, state: PlanStep["state"] = "GEPLANT") => steps.push({ system: "SHAREPOINT", title, detail, state });
  const ordered = f.status === "BEAUFTRAGT";
  const cancelled = f.status === "ABGESAGT" || f.status === "STORNIERT";
  const vermittler = f.channel === "VERMITTLER";
  const year = (f.startDate ?? new Date().toISOString()).slice(0, 4);

  if (cancelled) {
    moco("Lead „verloren“", f.status === "STORNIERT" ? "Projektende setzen, nichts löschen" : "Datei bleibt erhalten");
    return steps;
  }
  if (f.isRenewal) {
    if (ordered) moco("Projekt fortschreiben", `Projektende ${f.endDate ?? "?"}, neue Bestellnummer ${f.orderNumber ?? "?"}`);
    else moco("Kein neuer Lead", f.channel === "DIREKT" ? `Moco-Angebot ${f.offerNumber ?? "(Nummer fehlt)"} als „versendet“ markieren` : "Verlängerung wird am Einsatz geführt");
    sp("Ablage am Einsatz", `Kunden › ${f.endCustomerName ?? f.partnerName ?? "?"} › ${ordered ? "Bestellungen" : "Angebote"} › ${year}`);
    return steps;
  }
  // Angebotsphase
  if (vermittler) {
    moco("Lead am Vermittler", `Name „${leadName(f, f.endCustomerName ? `${f.partnerName} → ${f.endCustomerName}` : f.partnerName)}“, Phase „Angebot verschickt“${f.dailyRate ? `, Betrag ${f.dailyRate} €/Tag` : ""}`);
  } else {
    moco("Moco-Angebot verknüpfen", f.offerNumber ? `Angebot ${f.offerNumber} suchen, Lead am Kunden anlegen bzw. verknüpfen, Status „versendet“` : "Angebotsnummer fehlt – offene Moco-Angebote des Kunden zur Auswahl", f.offerNumber ? "GEPLANT" : "WARTET");
  }
  // Bestellphase
  if (ordered) {
    const customer = vermittler ? f.endCustomerName : f.partnerName;
    if (!customer) {
      moco("Projekt anlegen", "wartet auf den Endkunden – ohne Endkunde wird in Moco nichts angelegt", "WARTET");
    } else {
      if (vermittler) {
        moco("Firma Endkunde", `„${customer}“ suchen; neu nur nach ausdrücklicher Auswahl (R3)`);
        moco("Kontakt „Buchhaltung“", `Kontakt des Vermittlers ${f.partnerName ?? "?"} suchen bzw. anlegen`);
        moco("Lead umziehen", `Firma am Lead auf ${customer}, Name „${leadName(f, customer)}“, Schlagwort ${f.partnerName ?? "Vermittler"}`);
      }
      const h = hourlyRate(f.dailyRate);
      moco(
        "Projekt anlegen",
        [
          `Kunde ${customer}`,
          `Projektleitung ${f.bdName ?? "BD des Vorgangs"}`,
          `${f.startDate ?? "?"} bis ${f.endDate ?? "?"}`,
          h != null ? `Stundensatz ${h.toFixed(2).replace(".", ",")} € (Tagessatz ÷ 8)` : "Satz fehlt",
          f.days ? `Budget ${f.days * 8} Stunden` : null,
          `Bestellnummer ${f.orderNumber ?? "fehlt"}`,
          vermittler ? `Rechnungsempfänger Kontakt „Buchhaltung ${f.partnerName ?? ""}“, Zusatzfeld Vermittler = ${f.partnerName ?? "?"}` : "Vertriebskanal BUSINESS DEVELOPMENT",
        ]
          .filter(Boolean)
          .join(" · "),
      );
      moco("Person eintragen", `${f.personName ?? "Person offen"} als Mitarbeitende (Moco-Nutzer nötig, sonst Aufgabe ans Backoffice)`, f.personName ? "GEPLANT" : "WARTET");
      moco("Lead „gewonnen“", vermittler ? "und mit dem Projekt verknüpft" : `Angebot ${f.offerNumber ?? ""} „angenommen“ und verknüpft`.trim());
    }
  }
  const folder = vermittler && !f.endCustomerName ? `Vermittler › ${f.partnerName ?? "?"} › Endkunde offen › ${year}` : `Kunden › ${(vermittler ? f.endCustomerName : f.partnerName) ?? "?"} › ${ordered ? "Bestellungen" : "Angebote"} › ${year}`;
  sp(ordered ? "Bestellung ablegen" : "Angebot ablegen", `${folder}${vermittler ? `, Spalte Vermittler = ${f.partnerName ?? "?"}` : ""}`);
  return steps;
}

/** Offene Angaben am Vorgang (Markierungen, keine eigenen Zustände). */
export function openPoints(f: CaseFacts): string[] {
  const out: string[] = [];
  if (f.channel === "VERMITTLER" && !f.endCustomerName && !f.isRenewal) out.push("Endkunde fehlt");
  if (!f.personName) out.push("Person offen");
  if (f.status === "BEAUFTRAGT" && !f.orderNumber) out.push("Bestellnummer fehlt");
  if (!f.startDate || !f.endDate) out.push("Zeitraum fehlt");
  if (f.dailyRate == null) out.push("Satz fehlt");
  if (f.channel === "DIREKT" && !f.offerNumber && !f.isRenewal && f.status !== "BEAUFTRAGT") out.push("Moco-Angebotsnummer fehlt");
  return out;
}
