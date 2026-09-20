import Link from "next/link";
import { redirect } from "next/navigation";
import { getConfig } from "@/lib/config";
import { getCurrentActor } from "@/modules/identity/session";
import { canCreateAccount } from "@/modules/identity/authz";
import { getProviderStatus } from "@/modules/suggestions/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { startIntakeAction } from "../../../actions";

export default async function KundeAusDokumentPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  if (!canCreateAccount(actor)) redirect("/kunden?fehler=" + encodeURIComponent("Nur BD oder Principal legen Kunden an."));
  const ai = getProviderStatus();
  const maxMb = getConfig().MAX_UPLOAD_MB;
  return (
    <div className="space-y-6 max-w-3xl">
      <p className="text-sm"><Link href="/kunden">← Kunden</Link></p>
      <h1 className="text-2xl font-semibold">Kunde aus Dokument anlegen</h1>
      <Feedback params={sp} />
      <section className="card">
        <p className="text-sm mb-3">
          Schritt 1 von 2: Dokument hochladen. Der Text wird auf dem Server extrahiert und als <strong>persönliche Quelle</strong> gespeichert (nur Sie sehen sie, bis sie einem Setup zugeordnet ist).
          {ai.enabled ? " Anschließend schlägt die KI vor, was daraus angelegt werden könnte – jedes Element mit Textstelle, nichts wird ohne Ihre Bestätigung angelegt." : " KI ist deaktiviert: Sie füllen die Anlage im nächsten Schritt von Hand aus; der Dokumenttext steht daneben."}
        </p>
        <form action={startIntakeAction} encType="multipart/form-data" className="grid sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2"><label className="label" htmlFor="file">Datei (PDF, Word .docx, Excel .xlsx, CSV, Text, Markdown, E-Mail .eml – max. {maxMb} MB)</label><input id="file" name="file" type="file" className="input" required accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.eml,.json" /></div>
          <div><label className="label" htmlFor="title">Titel der Quelle (optional, sonst Dateiname)</label><input id="title" name="title" className="input" maxLength={200} placeholder="z. B. Erstgespräch Musterwerk 18.09." /></div>
          <div><label className="label" htmlFor="sourceTime">Datum des Dokuments (optional)</label><input id="sourceTime" name="sourceTime" type="datetime-local" className="input" /></div>
          <div className="sm:col-span-2"><button className="btn" type="submit">{ai.enabled ? "Hochladen und Vorschlag erzeugen" : "Hochladen und weiter"}</button></div>
        </form>
        <p className="muted text-sm mt-3">Hinweis: Dokumente mit personenbezogenen Daten Dritter nur im Rahmen der Pilotfreigabe hochladen. Der Dokumenttext geht {ai.enabled ? `an den konfigurierten KI-Anbieter (${ai.description})` : "an keinen externen Dienst"}.</p>
      </section>
    </div>
  );
}
