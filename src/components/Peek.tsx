"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * e78: Kurzansicht als Seitenblatt. Ein Klick auf eine Karte im Board, einen Balken der Zeitleiste oder den Namen in
 * einer Liste öffnet rechts eine Zusammenfassung (Status, Eckdaten, nächster Schritt) mit „Akte öffnen“. Die volle Seite
 * bleibt: Strg/Cmd-Klick, mittlere Maustaste und die Schaltfläche führen direkt dorthin. Auf dem Handy öffnet der Klick
 * wie bisher die Seite.
 */
type Data = { kind: string; title: string; subtitle: string | null; status: string | null; tone: "ok" | "warn" | "bad" | null; facts: [string, string][]; next: string | null; href: string; links: { label: string; href: string }[] };
const RE = /^\/(bedarfe|einsaetze|kunden)\/([0-9a-f]{8}-[0-9a-f-]{27})$/i;

export function Peek() {
  const path = usePathname();
  const [open, setOpen] = useState<{ typ: string; id: string; href: string } | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const [lastPath, setLastPath] = useState(path);
  if (path !== lastPath) { setLastPath(path); setOpen(null); }

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (!window.matchMedia("(min-width: 900px)").matches) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a");
      if (!a || a.target === "_blank" || a.closest(".peek")) return;
      // nur dort, wo eine Übersicht steht: Board-Karte, Zeitleisten-Balken, erste Spalte einer Liste
      if (!a.closest(".board-card, .tl-bar, table.list td:first-child") && !a.classList.contains("tl-bar")) return;
      const m = RE.exec(a.getAttribute("href") ?? "");
      if (!m) return;
      e.preventDefault();
      lastFocus.current = a;
      setData(null);
      setError(null);
      setOpen({ typ: m[1]!, id: m[2]!, href: a.getAttribute("href")! });
    };
    // Fangphase: vor der Navigation des Links (der bricht ab, sobald der Klick als behandelt markiert ist)
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    fetch(`/api/kurz?typ=${open.typ}&id=${open.id}`, { signal: ac.signal, headers: { accept: "application/json" } })
      .then(async (r) => { if (!r.ok) throw new Error(r.status === 404 || r.status === 403 ? "Kein Zugriff auf diesen Eintrag." : "Die Kurzansicht konnte nicht geladen werden."); return r.json(); })
      .then((d: Data) => setData(d))
      .catch((err: Error) => { if (err.name !== "AbortError") setError(err.message); });
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(null); lastFocus.current?.focus(); } };
    document.addEventListener("keydown", onKey);
    return () => { ac.abort(); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!open) return null;
  const close = () => { setOpen(null); lastFocus.current?.focus(); };
  return (
    <>
      <div className="peek-scrim" onClick={close} aria-hidden="true" />
      <aside className="peek" role="dialog" aria-modal="false" aria-label={data ? `Kurzansicht ${data.kind}: ${data.title}` : "Kurzansicht"}>
        <header className="peek-head">
          <span className="peek-kind">{data?.kind ?? "Kurzansicht"}</span>
          <button ref={closeRef} type="button" className="icon-btn" onClick={close} aria-label="Kurzansicht schließen">✕</button>
        </header>
        {error ? (
          <div className="peek-body"><p className="empty">{error}</p><Link href={open.href} className="btn mt-3">Seite öffnen</Link></div>
        ) : !data ? (
          <div className="peek-body" aria-busy="true"><div className="peek-skel" style={{ width: "70%", height: "1.4rem" }} /><div className="peek-skel" style={{ width: "45%" }} /><div className="peek-skel" style={{ width: "100%", height: "7rem", marginTop: "1rem" }} /></div>
        ) : (
          <div className="peek-body">
            <h2 className="peek-title">{data.title}</h2>
            {data.subtitle && <p className="muted text-sm">{data.subtitle}</p>}
            {data.status && <p className="mt-2"><span className="status" data-tone={data.tone ?? undefined}>{data.status}</span></p>}
            {data.next && <div className="peek-next"><span className="peek-label">Nächster Schritt</span>{data.next}</div>}
            <dl className="peek-facts">
              {data.facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>
            <div className="peek-actions">
              <Link href={data.href} className="btn">Akte öffnen</Link>
              {data.links.map((l) => <Link key={l.href} href={l.href} className="btn btn-secondary btn-small">{l.label}</Link>)}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
