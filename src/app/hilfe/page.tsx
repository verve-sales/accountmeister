import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { HELP_SECTIONS, searchHelp } from "@/modules/help/knowledge";
import { describeMySettings } from "@/modules/help/service";

/** Hilfe (Etappe 25): dieselben Abschnitte, aus denen der Assistent Bedienfragen beantwortet. */
export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const params = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const hits = q ? searchHelp(q, 5).map((h) => h.section) : [];
  const sections = q ? hits : HELP_SECTIONS;
  const mine = await describeMySettings(actor);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Hilfe</h1>
      <p className="muted text-sm">Handbuch, Funktionen und Einstellungen in Kurzform. Dieselben Inhalte kennt der Assistent – frag ihn einfach, z. B. „Wie bestätige ich eine Chance?“ oder „Wer darf den Fokus ändern?“.</p>
      <form className="flex flex-wrap gap-2 items-end" action="/hilfe">
        <div>
          <label className="label" htmlFor="helpQ">Suchen</label>
          <input id="helpQ" name="q" className="input" defaultValue={q} placeholder="z. B. Verlängerung, Rechte, Health-Check" />
        </div>
        <button className="btn btn-secondary" type="submit">Suchen</button>
        {q && <a href="/hilfe" className="text-sm">Alle Abschnitte</a>}
      </form>

      <section className="card">
        <h2 className="font-semibold mb-2">Deine Rollen und Einstellungen</h2>
        <p className="text-sm" style={{ whiteSpace: "pre-wrap" }}>{mine}</p>
      </section>

      {!q && (
        <nav aria-label="Inhalt" className="card">
          <h2 className="font-semibold mb-2">Inhalt</h2>
          <ul className="text-sm space-y-1">
            {HELP_SECTIONS.map((s) => (
              <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>
            ))}
          </ul>
        </nav>
      )}

      {q && sections.length === 0 && <p className="muted">Kein Abschnitt passt zu „{q}“. Versuch einen anderen Begriff oder frag den Assistenten.</p>}

      {sections.map((s) => (
        <section key={s.id} id={s.id} className="card">
          <h2 className="font-semibold">{s.title}</h2>
          <p className="muted text-sm mb-2">Wo: {s.where}</p>
          <div className="text-sm" style={{ whiteSpace: "pre-wrap" }}>{s.body}</div>
        </section>
      ))}
    </div>
  );
}
