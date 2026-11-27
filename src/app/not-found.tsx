import Link from "next/link";
import { Icon } from "@/components/Icon";

/** e65: eine einheitliche Seite für „nicht vorhanden“ und „keine Berechtigung“ statt stiller Weiterleitung. */
export default function NotFound() {
  return (
    <section className="card empty-state max-w-xl" role="alert">
      <Icon name="info" size={22} />
      <div>
        <h1 className="text-xl font-semibold mb-1">Nicht gefunden oder keine Berechtigung</h1>
        <p className="muted text-sm">Das Objekt existiert nicht, oder dieser Bereich liegt außerhalb deiner Rolle. Zugänge vergibt die Betriebsverwaltung (Verwaltung › Rollen).</p>
        <p className="mt-3 flex gap-2 flex-wrap"><Link href="/start" className="btn btn-small">Zur Startseite</Link><Link href="/hilfe" className="btn btn-secondary btn-small">Hilfe</Link></p>
      </div>
    </section>
  );
}
