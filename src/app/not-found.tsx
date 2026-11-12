import Link from "next/link";
export default function NotFound() {
  return (
    <section className="card max-w-lg">
      <h1 className="text-xl font-semibold mb-2">Nicht gefunden oder keine Berechtigung</h1>
      <p className="muted text-sm">Das Objekt existiert nicht oder liegt außerhalb Ihres Berechtigungsbereichs. <Link href="/start">Zurück zur Startseite</Link>.</p>
    </section>
  );
}
