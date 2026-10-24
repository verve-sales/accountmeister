import type { FetchedSource, SelectableItem } from "../adapter";

/**
 * Realistische, ausschließlich fiktive Testfixtures für den Microsoft-Graph-Adapter (Briefing 2.3: „Adaptervertrag
 * und realistische Testfixtures; keinen Anbieter als angeschlossen darstellen“). Alle Namen, Adressen und Inhalte sind erfunden.
 */
export const FIXTURE_MAILS: FetchedSource[] = [
  {
    kind: "MAIL",
    externalId: "AAMkFIXTURE-0001",
    subject: "Re: Kapazitäten nächste Phase",
    from: { name: "Keller, Anne", email: "keller@beispielkonzern.example" },
    participants: [{ name: "David Demo", email: "david.demo@verve.example" }],
    at: "2026-09-16T08:42:00Z",
    bodyText:
      "Hallo Herr Demo,\n\nwie besprochen: Für die nächste Migrationsphase koordiniert Frau Brandt die Kapazitätsplanung im Migrationsteam. Ob externe Unterstützung bei der Testkoordination vorgesehen ist, kann ich nicht sagen – das entscheidet sie mit Herrn Özdemir aus dem Einkauf.\n\nWenn Sie möchten, stelle ich Sie gern vor.\n\nViele Grüße\nAnne Keller",
    attachmentNames: [],
    contentHash: "fixture-mail-0001-v1",
  },
  {
    kind: "MAIL",
    externalId: "AAMkFIXTURE-0002",
    subject: "Einsatz B – Verlängerung?",
    from: { name: "Keller, Anne", email: "keller@beispielkonzern.example" },
    participants: [{ name: "David Demo", email: "david.demo@verve.example" }],
    at: "2026-09-17T14:05:00Z",
    bodyText: "Kurze Frage: Einsatz B läuft bei uns intern bis 31.03.2027 in der Planung. Passt das zu Ihrer Bestellung? Anhang: interne Planungsübersicht.",
    attachmentNames: ["Planung_Q4.xlsx"],
    contentHash: "fixture-mail-0002-v1",
  },
  {
    kind: "MAIL",
    externalId: "AAMkFIXTURE-0003",
    subject: "Newsletter: Plattform-Updates",
    from: { name: "Keller, Anne", email: "a.keller@anderer-konzern.example" },
    participants: [],
    at: "2026-09-15T06:00:00Z",
    bodyText: "Allgemeiner Newsletter ohne Projektbezug. <img src=\"https://tracker.example/pixel.gif\"> <script>alert(1)</script> Bitte hier klicken: https://tracker.example/klick",
    attachmentNames: [],
    contentHash: "fixture-mail-0003-v1",
  },
];

/** Teams-Chat (fiktiv): der Verlauf wird als Text mit Zeit und Name je Nachricht geliefert, älteste zuerst. */
export const FIXTURE_CHATS: FetchedSource[] = [
  {
    kind: "CHAT",
    externalId: "19:fixture-chat-0001@unq.gbl.spaces",
    subject: "Chat mit Anne Keller",
    from: { name: "Anne Keller", email: "keller@beispielkonzern.example" },
    participants: [
      { name: "Anne Keller", email: "keller@beispielkonzern.example" },
      { name: "David Demo", email: "david.demo@verve.example" },
    ],
    at: "2026-10-20T15:12:00Z",
    bodyText:
      "[20.10.2026 15:02] Anne Keller: Hallo Herr Demo, kurze Info vorab: Wir möchten den Einsatz von Frau Klein bis 31.03.2027 verlängern, Konditionen wie bisher.\n[20.10.2026 15:05] David Demo: Danke, das freut mich! Ich kümmere mich um den Nachtrag.\n[20.10.2026 15:12] Anne Keller: Super. Und bitte schicken Sie mir bis Ende des Monats zwei Profile für die Lasttests.",
    attachmentNames: [],
    contentHash: "fixture-chat-0001-v1",
  },
];

export const FIXTURE_EVENTS: FetchedSource[] = [
  {
    kind: "TERMIN",
    externalId: "AAMkEVENT-0001",
    subject: "Abstimmung Testkoordination Migration",
    from: { name: "Brandt, Julia", email: "brandt@beispielkonzern.example" },
    participants: [
      { name: "David Demo", email: "david.demo@verve.example" },
      { name: "Keller, Anne", email: "keller@beispielkonzern.example" },
    ],
    at: "2026-09-24T09:00:00Z",
    bodyText: "Einladung: 30 Minuten Abstimmung zur Testkoordination in der nächsten Phase. Teilnahme optional.",
    attachmentNames: [],
    meetingAcceptedByUser: false,
    contentHash: "fixture-event-0001-v1",
  },
];

export function toSelectable(s: FetchedSource): SelectableItem {
  return { kind: s.kind, externalId: s.externalId, subject: s.subject, from: s.from, participants: s.participants, at: s.at, preview: stripToPreview(s.bodyText), hasAttachments: s.attachmentNames.length > 0 };
}

function stripToPreview(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}
