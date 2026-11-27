import Link from "next/link";

/**
 * Zeitleiste der anstehenden Aufgaben (e50, Wunsch der BDs): Zeilen = Priorität, Spalten = Wochen.
 * Ganz links „überfällig“, rechts „später“ und – falls vorhanden – „ohne Datum“. Jede Karte führt zur Aufgabe.
 */
export type TimelineTask = { key: string; kind: "AUFGABE" | "VORGANG" | "CHECKIN" | "VERLAENGERUNG"; title: string; context: string; due: string | null; priority: "HOCH" | "NORMAL" | "NIEDRIG"; href: string };

const KIND: Record<TimelineTask["kind"], { label: string; color: string }> = {
  AUFGABE: { label: "Aufgabe", color: "#1f4e79" },
  VORGANG: { label: "Vorgang", color: "#6a4fa3" },
  CHECKIN: { label: "Check-in", color: "#2e7d6b" },
  VERLAENGERUNG: { label: "Verlängerung", color: "#b7791f" },
};
const PRIO: { key: TimelineTask["priority"]; label: string; color: string }[] = [
  { key: "HOCH", label: "Hoch", color: "var(--danger)" },
  { key: "NORMAL", label: "Normal", color: "#5f5f5a" },
  { key: "NIEDRIG", label: "Niedrig", color: "#9a9a92" },
];
const WEEKS = 4;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dm = (s: string) => `${Number(s.slice(8, 10))}.${Number(s.slice(5, 7))}.`;
const weekNo = (d: Date) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
};

export function TaskTimeline({ tasks, today, title, children }: { tasks: TimelineTask[]; today: string; title?: string; children?: React.ReactNode }) {
  const t = new Date(`${today}T00:00:00Z`);
  const monday = new Date(t);
  monday.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  const cols: { key: string; label: string; sub: string; from?: string; to?: string; current?: boolean }[] = [{ key: "over", label: "Überfällig", sub: `vor ${dm(today)}` }];
  for (let w = 0; w < WEEKS; w++) {
    const a = new Date(monday);
    a.setUTCDate(monday.getUTCDate() + w * 7);
    const b = new Date(a);
    b.setUTCDate(a.getUTCDate() + 6);
    cols.push({ key: `w${w}`, label: w === 0 ? "Diese Woche" : w === 1 ? "Nächste Woche" : `KW ${weekNo(a)}`, sub: `${dm(iso(a))} – ${dm(iso(b))}`, from: iso(a), to: iso(b), current: w === 0 });
  }
  const end = cols[cols.length - 1]!.to!;
  cols.push({ key: "later", label: "Später", sub: `ab ${dm(iso(new Date(Date.parse(`${end}T00:00:00Z`) + 86400000)))}` });
  const undated = tasks.filter((x) => !x.due);
  if (undated.length) cols.push({ key: "none", label: "Ohne Datum", sub: "bitte terminieren" });
  const colOf = (x: TimelineTask) => (!x.due ? "none" : x.due < today ? "over" : x.due > end ? "later" : cols.find((c) => c.from && x.due! >= c.from && x.due! <= c.to!)!.key);
  const sorted = [...tasks].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.title.localeCompare(b.title, "de"));
  const lanes = PRIO.filter((p) => p.key !== "NIEDRIG" || tasks.some((x) => x.priority === "NIEDRIG"));
  const overdue = tasks.filter((x) => x.due && x.due < today).length;
  return (
    <section className="card" id="zeitleiste" aria-label="Zeitleiste meiner Aufgaben">
      <div className="flex flex-wrap items-baseline gap-3 mb-2">
        <h2 className="font-semibold">{title ?? "Wochenplan"} ({tasks.length})</h2>
        {overdue > 0 && <span className="text-sm" style={{ color: "var(--danger)", fontWeight: 600 }}>{overdue} überfällig</span>}
        <span className="muted text-xs flex flex-wrap gap-3 ml-auto">{Object.values(KIND).map((k) => <span key={k.label}><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: k.color, marginRight: 4 }} />{k.label}</span>)}</span>
      </div>
      {children}
      {tasks.length === 0 ? <p className="empty">Nichts geplant – neue Aufgaben oben eintragen.</p> : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: `5.5rem repeat(${cols.length}, minmax(8.5rem, 1fr))`, gap: 4, minWidth: `${5.5 + cols.length * 8.8}rem` }}>
            <div />
            {cols.map((c) => (
              <div key={c.key} className="text-xs" style={{ padding: "4px 6px", borderRadius: 6, background: c.current ? "var(--accent-soft)" : "var(--surface-2)", color: c.key === "over" ? "var(--danger)" : undefined }}>
                <strong>{c.label}</strong>
                <div className="muted">{c.sub}</div>
              </div>
            ))}
            {lanes.map((p) => (
              <Lane key={p.key} p={p} cols={cols} items={sorted.filter((x) => x.priority === p.key)} colOf={colOf} today={today} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Lane({ p, cols, items, colOf, today }: { p: (typeof PRIO)[number]; cols: { key: string; current?: boolean }[]; items: TimelineTask[]; colOf: (x: TimelineTask) => string; today: string }) {
  return (
    <>
      <div className="text-xs font-semibold" style={{ padding: "6px 4px", borderLeft: `4px solid ${p.color}`, color: p.color }}>{p.label}<div className="muted font-normal">{items.length}</div></div>
      {cols.map((c) => {
        const cell = items.filter((x) => colOf(x) === c.key);
        return (
          <div key={c.key} style={{ minHeight: 44, padding: 3, borderRadius: 6, border: "1px dashed var(--border)", background: c.current ? "color-mix(in srgb, var(--accent-soft) 45%, transparent)" : undefined, display: "flex", flexDirection: "column", gap: 3 }}>
            {cell.slice(0, 6).map((x) => (
              <Link key={x.key} href={x.href} title={`${KIND[x.kind].label}: ${x.title}${x.context ? ` · ${x.context}` : ""}${x.due ? ` · ${dm(x.due)}` : ""}`} className="no-underline text-xs" style={{ display: "block", padding: "3px 6px", borderRadius: 5, background: "var(--surface)", border: "1px solid var(--border)", borderLeft: `4px solid ${KIND[x.kind].color}`, color: "var(--text)", lineHeight: 1.3 }}>
                <span style={{ overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", fontWeight: 500 }}>{x.title}</span>
                <span className="muted" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: x.due && x.due < today ? "var(--danger)" : undefined }}>{x.due ? dm(x.due) : "–"}{x.context ? ` · ${x.context}` : ""}</span>
              </Link>
            ))}
            {cell.length > 6 && <span className="muted text-xs" style={{ padding: "0 4px" }}>+ {cell.length - 6} weitere</span>}
          </div>
        );
      })}
    </>
  );
}
