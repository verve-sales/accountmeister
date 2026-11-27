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

type ViewState = { hidden: number[]; sort: { col: number; dir: "ascending" | "descending" } | null; q: string };
let seq = 0;

function enhance(table: HTMLTableElement) {
  if (table.dataset.tools === "1") return;
  const head = table.tHead?.rows[0];
  const body = table.tBodies[0];
  if (!head || !body || body.rows.length < 2) return;
  table.dataset.tools = "1";
  const ths = Array.from(head.cells);
  // e75: Ansicht je Tabelle (Spalten, Sortierung, Filter) – wird im Browser gemerkt; benannte Ansichten zum Umschalten
  const sig = `${location.pathname}|${ths.map((t) => (t.textContent ?? "").trim()).join("|")}`.slice(0, 300);
  const KEY = `am:ansicht:${sig}`;
  const KEY_NAMED = `am:ansichten:${sig}`;
  const load = <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
  const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* privates Fenster */ } };
  const state: ViewState = { hidden: [], sort: null, q: "", ...load<Partial<ViewState>>(KEY, {}) };
  state.hidden = (state.hidden ?? []).filter((c) => c > 0 && c < ths.length);
  const tid = String(++seq);
  table.dataset.tt = tid;
  const style = document.createElement("style");
  document.head.appendChild(style);
  const applyHidden = () => {
    style.textContent = state.hidden.map((c) => `table.list[data-tt="${tid}"] tr > :nth-child(${c + 1}) { display: none !important; }`).join("\n");
  };
  const sorters = new Map<number, (dir: "ascending" | "descending") => void>();
  const persist = () => save(KEY, state);
  ths.forEach((th, col) => {
    if (!th.textContent?.trim() || th.hasAttribute("data-nosort") || th.colSpan > 1) return;
    th.classList.add("sortable");
    th.tabIndex = 0;
    th.setAttribute("role", "columnheader");
    th.title = "Sortieren";
    const sortBy = (dir: "ascending" | "descending") => {
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
    sorters.set(col, sortBy);
    const run = () => {
      const dir = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
      sortBy(dir);
      state.sort = { col, dir };
      persist();
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
  const wantsFilter = body.rows.length >= 6 && !table.hasAttribute("data-nofilter") && !ownSearch;
  const wrap = document.createElement("div");
  wrap.className = "table-filter";
  let applyFilter: (text: string, keep?: boolean) => void = () => {};
  // e68 (E6): CSV-Export der sichtbaren Zeilen – Semikolon und BOM, damit Excel (deutsch) die Datei direkt öffnet
  if (body.rows.length >= 6 && !table.hasAttribute("data-noexport")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-secondary btn-small table-export";
    btn.textContent = "CSV";
    btn.title = "Sichtbare Zeilen als CSV herunterladen";
    btn.addEventListener("click", () => {
      const esc = (v: string) => `"${v.replace(/\s+/g, " ").trim().replace(/"/g, '""')}"`;
      const vis = (_: unknown, i: number) => !state.hidden.includes(i);
      const head = ths.filter(vis).map((th) => esc(th.textContent ?? ""));
      const lines = Array.from(body.rows).filter((r) => r.style.display !== "none").map((r) => Array.from(r.cells).filter(vis).map((c) => esc(c.innerText || c.textContent || "")).join(";"));
      const blob = new Blob([`\ufeff${[head.join(";"), ...lines].join("\r\n")}`], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      const title = (document.querySelector("main.page h1")?.textContent ?? "liste").trim().toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-").replace(/^-|-$/g, "");
      a.href = URL.createObjectURL(blob);
      a.download = `${title || "liste"}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    wrap.append(btn);
  }
  if (wantsFilter) {
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "In dieser Liste filtern …";
    input.setAttribute("aria-label", "Liste filtern");
    const count = document.createElement("span");
    count.className = "table-filter-count";
    const total = body.rows.length;
    count.textContent = `${total} Einträge`;
    applyFilter = (text: string, keep = true) => {
      input.value = text;
      const q = text.trim().toLocaleLowerCase("de");
      let shown = 0;
      for (const r of Array.from(body.rows)) {
        const hit = !q || (r.textContent ?? "").toLocaleLowerCase("de").includes(q);
        r.style.display = hit ? "" : "none";
        if (hit) shown++;
      }
      count.textContent = q ? `${shown} von ${total}` : `${total} Einträge`;
      if (keep) { state.q = text; persist(); }
    };
    input.addEventListener("input", () => applyFilter(input.value));
    wrap.prepend(input, count);
  }
  const applyAll = () => {
    applyHidden();
    if (state.sort && sorters.has(state.sort.col)) sorters.get(state.sort.col)!(state.sort.dir);
    else ths.forEach((x) => x.removeAttribute("aria-sort"));
    applyFilter(state.q ?? "", false);
  };
  // Menü „Ansicht“: Spalten ein-/ausblenden, benannte Ansichten speichern und anwenden
  if (ths.length >= 4 && !table.hasAttribute("data-noview")) {
    const menu = document.createElement("details");
    menu.className = "row-more view-menu";
    const sum = document.createElement("summary");
    sum.className = "btn btn-secondary btn-small";
    sum.title = "Spalten wählen und Ansichten speichern";
    const pop = document.createElement("div");
    pop.className = "view-pop";
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
    const render = () => {
      const named = load<{ name: string; state: ViewState }[]>(KEY_NAMED, []);
      const changed = state.hidden.length > 0;
      sum.textContent = changed ? `Ansicht · ${ths.length - state.hidden.length}/${ths.length} Spalten` : "Ansicht";
      pop.textContent = "";
      pop.append(el("div", "view-head", "Spalten"));
      ths.forEach((th, col) => {
        const name = (th.textContent ?? "").trim();
        if (!name || col === 0) return;
        const lab = el("label", "view-col");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = !state.hidden.includes(col);
        cb.addEventListener("change", () => {
          state.hidden = cb.checked ? state.hidden.filter((c) => c !== col) : [...state.hidden, col];
          applyHidden(); persist(); render();
        });
        lab.append(cb, document.createTextNode(` ${name}`));
        pop.append(lab);
      });
      pop.append(el("div", "view-head", "Gespeicherte Ansichten"));
      if (!named.length) pop.append(el("div", "view-empty", "Noch keine – unten Namen eingeben und speichern."));
      named.forEach((v, i) => {
        const row = el("div", "view-saved");
        const use = el("button", "view-use", v.name);
        use.type = "button";
        use.addEventListener("click", () => { Object.assign(state, { hidden: [], sort: null, q: "" }, v.state); applyAll(); persist(); render(); });
        const del = el("button", "view-del", "×");
        del.type = "button";
        del.title = `Ansicht „${v.name}“ löschen`;
        del.setAttribute("aria-label", del.title);
        del.addEventListener("click", () => { save(KEY_NAMED, named.filter((_, k) => k !== i)); render(); });
        row.append(use, del);
        pop.append(row);
      });
      const form = el("div", "view-save");
      const nameIn = el("input");
      nameIn.type = "text";
      nameIn.placeholder = "Name, z. B. „ohne Konditionen“";
      nameIn.maxLength = 40;
      nameIn.setAttribute("aria-label", "Name der Ansicht");
      const saveBtn = el("button", "btn btn-small", "Speichern");
      saveBtn.type = "button";
      const doSave = () => {
        const n = nameIn.value.trim();
        if (!n) { nameIn.focus(); return; }
        save(KEY_NAMED, [...named.filter((v) => v.name !== n), { name: n, state: { hidden: [...state.hidden], sort: state.sort, q: state.q } }].slice(-12));
        render();
      };
      saveBtn.addEventListener("click", doSave);
      nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });
      form.append(nameIn, saveBtn);
      pop.append(form);
      const reset = el("button", "view-reset", "Zurücksetzen (alle Spalten, keine Sortierung)");
      reset.type = "button";
      reset.addEventListener("click", () => { Object.assign(state, { hidden: [], sort: null, q: "" }); applyAll(); persist(); render(); });
      pop.append(reset);
    };
    render();
    menu.append(sum, pop);
    wrap.append(menu);
  }
  applyAll();
  if (wrap.childElementCount) {
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
