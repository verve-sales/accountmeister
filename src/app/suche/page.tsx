import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { searchAll } from "@/modules/search/service";

export default async function SuchePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const q = (sp.q ?? "").trim();
  const r = q ? await searchAll(actor, q) : { q, groups: [] };
  const total = r.groups.reduce((n, g) => n + g.hits.length, 0);
  // Ein eindeutiger Treffer: direkt hin
  if (total === 1) redirect(r.groups[0]!.hits[0]!.href);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Suche</h1>
      <form method="get" action="/suche" className="flex gap-2 items-center text-sm">
        <input name="q" className="input" defaultValue={q} placeholder="Kunde, Person, Einsatz, Chance …" aria-label="Suchbegriff" autoFocus style={{ minWidth: 320 }} />
        <button className="btn btn-small" type="submit">Suchen</button>
      </form>
      {q && q.length < 2 && <p className="muted text-sm">Mindestens zwei Zeichen.</p>}
      {q.length >= 2 && total === 0 && <p className="muted text-sm">Nichts gefunden für „{q}“ – gesucht wird in Kunden, Freelancern, Einsätzen, Chancen, Setups und Zugängen, die du sehen darfst.</p>}
      {r.groups.map((g) => (
        <section key={g.kind} className="card">
          <h2 className="font-semibold mb-2">{g.label} ({g.hits.length})</h2>
          <ul className="space-y-1 text-sm">
            {g.hits.map((h) => (
              <li key={h.id}><Link href={h.href}><strong>{h.title}</strong></Link> <span className="muted text-xs">{h.subtitle}</span></li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
