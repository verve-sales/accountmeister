/** Ehrliche Kennzeichnung noch nicht umgesetzter Bereiche (Briefing 21: keine „kommt später“-Schaltflächen als fertige Funktion). */
export function NotYet({ title, etappe, inhalt }: { title: string; etappe: string; inhalt: string }) {
  return (
    <section className="card">
      <h1 className="text-xl font-semibold mb-2">{title}</h1>
      <p className="muted">
        Dieser Bereich ist noch nicht umgesetzt (vorgesehen in {etappe}). Geplant: {inhalt}
      </p>
    </section>
  );
}
