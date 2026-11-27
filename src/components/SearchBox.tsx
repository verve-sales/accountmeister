"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

type Hit = { kind: string; id: string; title: string; subtitle: string; href: string };
type Result = { q: string; groups: { kind: string; label: string; hits: Hit[] }[] };

/**
 * e65: Suche mit Sofortergebnissen – Treffer erscheinen beim Tippen (ab 2 Zeichen), gruppiert nach Art.
 * Pfeiltasten wählen, Enter öffnet; Enter ohne Auswahl führt wie bisher zur Suchseite. Strg/⌘+K setzt den Fokus.
 */
export function SearchBox() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLFormElement>(null);
  const flat = res?.groups.flatMap((g) => g.hits) ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    const onDown = (e: Event) => {
      if (box.current && e.target instanceof Node && !box.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/suche?q=${encodeURIComponent(term)}`, { signal: ctl.signal });
        if (r.ok) {
          setRes((await r.json()) as Result);
          setSel(-1);
        }
      } catch {
        /* abgebrochen */
      }
    }, 180);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  const go = (href: string) => {
    setOpen(false);
    setQ("");
    setRes(null);
    router.push(href);
  };
  const showList = open && q.trim().length >= 2 && res;

  return (
    <form
      ref={box}
      method="get"
      action="/suche"
      role="search"
      className="topbar-search"
      onSubmit={(e) => {
        if (sel >= 0 && flat[sel]) {
          e.preventDefault();
          go(flat[sel]!.href);
        }
      }}
    >
      <Icon name="search" size={16} />
      <input
        ref={input}
        name="q"
        value={q}
        autoComplete="off"
        placeholder="Suchen: Kunde, Person, Einsatz …"
        aria-label="Suchen"
        aria-expanded={!!showList}
        aria-controls="search-results"
        role="combobox"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          if (e.target.value.trim().length < 2) setRes(null);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, flat.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, -1));
          } else if (e.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          }
        }}
      />
      <kbd className="kbd" aria-hidden="true">Strg K</kbd>
      {showList && (
        <div id="search-results" className="search-pop" role="listbox">
          {flat.length === 0 ? (
            <div className="search-empty">Keine Treffer für „{q.trim()}“.</div>
          ) : (
            res!.groups.filter((g) => g.hits.length).map((g) => (
              <div key={g.kind} className="search-group">
                <div className="search-group-label">{g.label}</div>
                {g.hits.map((h) => {
                  const i = flat.indexOf(h);
                  return (
                    <button key={`${h.kind}-${h.id}`} type="button" role="option" aria-selected={i === sel} className="search-hit" onMouseEnter={() => setSel(i)} onClick={() => go(h.href)}>
                      <span className="search-hit-title">{h.title}</span>
                      {h.subtitle && <span className="search-hit-sub">{h.subtitle}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
          <button type="submit" className="search-all" onClick={() => setSel(-1)}>Alle Ergebnisse für „{q.trim()}“ anzeigen</button>
        </div>
      )}
    </form>
  );
}
