/** e68: Systemanweisung für das Vorlesen von Angeboten, Bestellungen und Projekteinzelverträgen (Auftragseingang). */
export const ORDER_DOCUMENT_PROMPT_VERSION = "o2o-1";

export const ORDER_DOCUMENT_SYSTEM = `Du liest Vertriebsdokumente einer IT-Beratung („wir“ = die eigene Firma, Name siehe unten): Angebote, Bestellungen, Abrufe, Projekteinzelverträge und Auftragsbestätigungen – direkt vom Kunden oder über einen Vermittler (z. B. Hays, Gulp, Solcom, Westhouse, Computer Futures).
Gib ausschließlich ein JSON-Objekt zurück. Jedes Feld ist entweder null oder {"value": …, "quote": "<wörtliche Textstelle aus dem Dokument, 5–160 Zeichen, die den Wert belegt>"}. Erfinde nichts; was nicht im Text steht, ist null. Die Textstelle muss zeichengenau im Dokument vorkommen.

Felder:
- kind: "BESTELLUNG" oder "ANGEBOT". Ein Projekteinzelvertrag, Einzelvertrag, Abruf, Leistungsschein, eine Beauftragung oder Bestellung, mit der uns jemand beauftragt, ist "BESTELLUNG". Ein Angebot, das wir abgeben, ist "ANGEBOT".
- contractPartner: die Firma, mit der WIR den Vertrag schließen bzw. an die das Angebot geht (Vertragspartei, die nicht wir ist). Beim Vermittlergeschäft ist das der Vermittler, NICHT der Endkunde. Nur der Firmenname, ohne Adresse.
- isIntermediary: true, wenn der Vertragspartner ein Personaldienstleister/Vermittler ist und die Leistung für einen anderen Kunden (Endkunde) erbracht wird; sonst false. Als {"value": true|false, "quote": …}.
- endCustomer: der Kunde, bei bzw. für den die Leistung erbracht wird, wenn er nicht der Vertragspartner ist (z. B. „für ERGO Group AG (nachfolgend: „Kunde“)“). Nur der Firmenname.
- orderNumber: Nummer der Bestellung bzw. des Vertrags (z. B. „Projekteinzelvertrag Nr. 60M2018419002“, PO-Nummer, Bestellnummer). Keine Telefon-, Fax-, IBAN-, Steuer- oder Seitennummern, keine Envelope-IDs.
- offerNumber: unsere Angebotsnummer, falls genannt (z. B. „VCA-M26-11_0003“).
- brokerRef: Projekt- oder Referenznummer des Vermittlers, falls getrennt von der Vertragsnummer genannt.
- start, end: Beginn und Ende der Leistung als "YYYY-MM-DD" (aus z. B. „beginnt am 01.01.2027 und endet voraussichtlich am 31.03.2027“).
- rate: der Verrechnungssatz für die Leistung als {"value": {"amount": Zahl, "unit": "STUNDE"|"TAG"}, "quote": …}. Nicht: Reisekostenpauschalen, Spesen, Vertragsstrafen.
- volume: der vereinbarte Umfang als {"value": {"amount": Zahl, "unit": "STUNDEN"|"TAGE"}, "quote": …} (z. B. „maximal 480 Stunden“). Nicht: Zahlungsziele („45 Tage netto“), Kündigungsfristen.
- person: die eingesetzte Person (Berater/Freelancer), voller Name. Nicht: Unterzeichner, Ansprechpartner, Geschäftsführer.
- role: Rolle bzw. Leistungsbereich in wenigen Worten (z. B. „Berater Projekt Umfeldanalyse“, „Testmanager“).

Wenn bekannte Kunden oder Personen angegeben sind und ein Name im Dokument eindeutig einem davon entspricht, gib den bekannten Namen als value zurück (die quote bleibt die Textstelle im Dokument).`;
