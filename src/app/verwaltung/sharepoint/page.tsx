import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { getConfig } from "@/lib/config";
import { canManageSharePoint, COLUMNS, FREELANCER_SUB, KUNDE_SUB, permissionPlan, siteStatus, VORLAGEN_SUB } from "@/modules/sharepoint/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { PendingButton } from "@/components/PendingButton";
import { setupSharePointAction } from "../../actions";

export const metadata = { title: "SharePoint-Ablage" };

const GREEN = "#2f7d32";
const AMBER = "#b7791f";

/**
 * Verwaltung → SharePoint (e45): Stand der Site, Einrichten auf Knopfdruck, und was der Besitzer von Hand tut
 * (Rechte je Bibliothek, optionale Ansichten) – mit den Namen aus den Rollen im Accountmeister.
 */
export default async function SharePointPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!canManageSharePoint(actor)) notFound();
  const cfg = getConfig();
  const [status, plan] = await Promise.all([siteStatus(actor), permissionPlan(actor)]);
  const complete = status.ok && status.libraries.every((l) => l.present && l.columnsMissing.length === 0);

  return (
    <div className="space-y-5">
      <p className="text-sm"><Link href="/verwaltung">← Verwaltung</Link></p>
      <h1 className="text-2xl font-semibold">SharePoint-Ablage</h1>
      <Feedback params={sp} />

      <section className="card space-y-2 text-sm">
        <h2 className="font-semibold">1. Site einrichten</h2>
        {!status.enabled ? (
          <>
            <p style={{ color: AMBER }}>Die Anbindung ist aus. Auf dem Server in <code>.env.production</code> eintragen und die App neu starten:</p>
            <pre className="text-xs" style={{ background: "var(--surface-2)", padding: ".6rem", borderRadius: 6, overflowX: "auto" }}>SHAREPOINT_MODE=graph{"\n"}SHAREPOINT_SITE_ID=&lt;Site-ID aus dem Graph Explorer&gt;</pre>
          </>
        ) : !status.ok ? (
          <p style={{ color: "#c0392b" }}>Die Site ist nicht erreichbar: {status.error}. Meist fehlt das Recht der App auf die Site (Sites.Selected) oder die Site-ID stimmt nicht.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Bibliothek</th><th>Stand</th></tr></thead>
            <tbody>
              {status.libraries.map((l) => (
                <tr key={l.name}>
                  <td>{l.name}</td>
                  <td>{!l.present ? <span style={{ color: AMBER }}>fehlt</span> : l.columnsMissing.length ? <span style={{ color: AMBER }}>Spalten fehlen: {l.columnsMissing.join(", ")}</span> : <span style={{ color: GREEN }}>vollständig</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {status.enabled && (
          <>
            <p>Legt an, was fehlt: die Bibliotheken Kunden, Freelancer und Vorlagen, die Spalten ({COLUMNS.map((c) => c.displayName).join(", ")}) und je Kunde und Freelancer mit laufendem Einsatz einen Ordner – bei Kunden mit {KUNDE_SUB.join(", ")}, bei Freelancern mit {FREELANCER_SUB.join(" und ")}, unter Vorlagen {VORLAGEN_SUB.join(" und ")}. Vorhandenes bleibt unverändert; der Knopf darf jederzeit erneut gedrückt werden, etwa für neue Kunden.</p>
            <form action={setupSharePointAction}><PendingButton busy="Richte ein …">{complete ? "Ordner ergänzen" : "SharePoint einrichten"}</PendingButton></form>
          </>
        )}
        <p className="muted text-xs">Site: {cfg.SHAREPOINT_SITE_ID ? cfg.SHAREPOINT_SITE_ID.split(",")[0] : "–"} · Modus {cfg.SHAREPOINT_MODE}. Erzeugte Projekteinzelverträge legt der Accountmeister danach selbst unter Freelancer › Person › Verträge ab und führt den Status dort nach.</p>
      </section>

      <section className="card space-y-2 text-sm" id="rechte">
        <h2 className="font-semibold">2. Rechte vergeben – einmalig, durch den Besitzer der Site</h2>
        <p>Rechte für Personen kann der Accountmeister nicht setzen. Je Bibliothek so (etwa 5 Minuten pro Bibliothek):</p>
        <ol className="list-decimal ml-5 space-y-1">
          <li>Bibliothek öffnen → Zahnrad oben rechts → <strong>Bibliothekseinstellungen</strong> → <strong>Weitere Bibliothekseinstellungen</strong> → <strong>Berechtigungen für diese Dokumentbibliothek</strong>.</li>
          <li><strong>Berechtigungen nicht mehr erben</strong> → OK.</li>
          <li><strong>Berechtigungen erteilen</strong> → Namen eintragen → <strong>Optionen anzeigen</strong> → Berechtigungsstufe wählen → Haken bei „E-Mail-Einladung senden“ entfernen → <strong>Teilen</strong>. Je Stufe einmal.</li>
        </ol>
        <table className="list">
          <thead><tr><th>Rolle</th><th>Kunden</th><th>Freelancer</th><th>Vorlagen</th><th>Personen laut Accountmeister</th></tr></thead>
          <tbody>
            {plan.map((r) => (
              <tr key={r.rolle}>
                <td><strong>{r.rolle}</strong></td>
                <td>{r.kunden}</td>
                <td>{r.freelancer}</td>
                <td>{r.vorlagen}</td>
                <td className="text-xs">{r.personen.length ? r.personen.map((x) => `${x.name} (${x.email})`).join(", ") : r.rolle === "Buchhaltung" ? <span className="muted">nicht im Accountmeister – Namen selbst eintragen</span> : <span className="muted">niemand mit dieser Rolle</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted text-xs">Wer in mehreren Rollen ist, steht nur bei der höchsten. Den Vertrieb nicht in der Bibliothek Freelancer eintragen – dort stehen die Einkaufssätze. Die Startseite der Site sehen die Personen nur, wenn sie auch unter Websiteberechtigungen eingetragen sind; der Link zur Bibliothek genügt aber.</p>
      </section>

      <details className="card text-sm">
        <summary className="font-semibold" style={{ cursor: "pointer" }}>3. Ansichten (optional)</summary>
        <div className="space-y-2 mt-2">
          <p>Ansichten kann der Accountmeister nicht anlegen. Wer sie möchte: Bibliothek öffnen → über der Liste <strong>Filter</strong> setzen → oben rechts <strong>Ansicht speichern unter</strong>. Damit Dateien aus allen Ordnern erscheinen: Ansicht bearbeiten → <strong>Ordner</strong> → „Alle Elemente ohne Ordner anzeigen“.</p>
          <ul className="list-disc ml-5">
            <li><strong>Unterschrift fehlt</strong> (Kunden und Freelancer): Status ist Entwurf oder versendet.</li>
            <li><strong>Laufende Bestellungen</strong> (Kunden): Dokumentart Bestellung, sortiert nach Gültig bis.</li>
            <li><strong>Nach Person</strong>: gruppiert nach der Spalte Person.</li>
          </ul>
        </div>
      </details>
    </div>
  );
}
