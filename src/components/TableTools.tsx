"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * e65: Alle Listen-Tabellen (table.list) werden sortierbar (Klick auf den Spaltenkopf) und ab 6 Zeilen filterbar
 * (Suchfeld über der Tabelle). Rein im Browser auf den angezeigten Zeilen – keine Daten werden geändert oder geladen.
 * Spalten ohne Überschrift oder mit data-nosort bleiben unsortiert.
 */

const DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})/;

function sortKey(text: string): { n: number | null; s: string } {
  const t = text.replace(/\s+/g, " ").trim();
  const d = DATE.exec(t);
  if (d) return { n: Date.UTC(+d[3]!, +d[2]! - 1, +d[1]!), s: t };
  const iso = ISO.exec(t);
  if (iso) return { n: Date.UTC(+iso[1]!, +iso[2]! - 1, +iso[3]!), s: t };
  // Zahl am Anfang (z. B. „960 €“, „33 %“, „19 T.“, „1.234,50“)
  const m = /^[-–]?\s*\d[\d.]*(,\d+)?/.exec(t);
  if (m) return { n: Number(m[0].replace(/[–\s]/g, (c) => (c === "–" ? "-" : "")).replace(/\./g, "").replace(",", ".")), s: t };
  if (t === "–" || t === "-" || t === "") return { n: null, s: "" };
  return { n: null, s: t.toLocaleLowerCase("de") };
}

function enhance(table: HTMLTableElement) {
  if (table.dataset.tools === "1") return;
  const head = table.tHead?.rows[0];
  const body = table.tBodies[0];
  if (!head || !body || body.rows.length < 2) return;
  table.dataset.tools = "1";
  const ths = Array.from(head.cells);
  ths.forEach((th, col) => {
    if (!th.textContent?.trim() || th.hasAttribute("data-nosort") || th.colSpan > 1) return;
    th.classList.add("sortable");
    th.tabIndex = 0;
    th.setAttribute("role", "columnheader");
    th.title = "Sortieren";
    const run = () => {
      const dir = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
      ths.forEach((x) => x.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", dir);
      const rows = Array.from(body.rows);
      const keyed = rows.map((r, i) => ({ r, i, k: sortKey(r.cells[col]?.textContent ?? "") }));
      keyed.sort((a, b) => {
        // leere Werte immer ans Ende
        const ae = a.k.n === null && a.k.s === "";
        const be = b.k.n === null && b.k.s === "";
        if (ae !== be) return ae ? 1 : -1;
        let c = 0;
        if (a.k.n !== null && b.k.n !== null) c = a.k.n - b.k.n;
        else c = a.k.s.localeCompare(b.k.s, "de", { numeric: true });
        return (dir === "ascending" ? c : -c) || a.i - b.i;
      });
      for (const { r } of keyed) body.appendChild(r);
    };
    th.addEventListener("click", run);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        run();
      }
    });
  });
  // e66: Seiten mit eigener Suche (Feld „q“) bekommen kein zweites Filterfeld – ein Filtermuster je Seite
  const ownSearch = !!document.querySelector('main.page form input[name="q"]');
  if (body.rows.length >= 6 && !table.hasAttribute("data-nofilter") && !ownSearch) {
    const wrap = document.createElement("div");
    wrap.className = "table-filter";
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "In dieser Liste filtern …";
    input.setAttribute("aria-label", "Liste filtern");
    const count = document.createElement("span");
    count.className = "table-filter-count";
    const total = body.rows.length;
    count.textContent = `${total} Einträge`;
    input.addEventListener("input", () => {
      const q = input.value.trim().toLocaleLowerCase("de");
      let shown = 0;
      for (const r of Array.from(body.rows)) {
        const hit = !q || (r.textContent ?? "").toLocaleLowerCase("de").includes(q);
        r.style.display = hit ? "" : "none";
        if (hit) shown++;
      }
      count.textContent = q ? `${shown} von ${total}` : `${total} Einträge`;
    });
    wrap.append(input, count);
    const anchor = table.closest(".table-wrap") ?? table;
    anchor.parentElement?.insertBefore(wrap, anchor);
  }
}

export function TableTools() {
  const path = usePathname();
  useEffect(() => {
    const run = () => document.querySelectorAll<HTMLTableElement>("main.page table.list").forEach(enhance);
    run();
    const main = document.querySelector("main.page");
    const mo = new MutationObserver(() => run());
    if (main) mo.observe(main, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [path]);
  return null;
}
