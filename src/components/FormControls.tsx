"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * e72: Eigene Formular-Bausteine für alle Formulare, ohne jedes Formular umzubauen.
 * - Auswahllisten ab 8 Einträgen öffnen eine durchsuchbare Liste (Tippen filtert, Pfeiltasten, Enter).
 * - Datumsfelder öffnen einen Kalender mit Montag als Wochenbeginn, „Heute“ und „Monatsende“; Tippen bleibt möglich.
 * Die Felder selbst bleiben die normalen Formularfelder (Wert, Pflicht, Absenden unverändert). Auf Touch-Geräten
 * bleibt die Auswahl des Geräts, weil sie dort besser bedienbar ist.
 */
type Open =
  | { kind: "select"; el: HTMLSelectElement; seed: string }
  | { kind: "date"; el: HTMLInputElement };

const MIN_OPTIONS = 8;
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (v: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null; };
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

function setNative(el: HTMLSelectElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const eligibleSelect = (t: EventTarget | null): HTMLSelectElement | null =>
  t instanceof HTMLSelectElement && !t.multiple && !t.disabled && t.size <= 1 && t.options.length >= MIN_OPTIONS && !t.hasAttribute("data-native") ? t : null;
const eligibleDate = (t: EventTarget | null): HTMLInputElement | null =>
  t instanceof HTMLInputElement && t.type === "date" && !t.disabled && !t.readOnly && !t.hasAttribute("data-native") ? t : null;

export function FormControls() {
  const [open, setOpen] = useState<Open | null>(null);
  const [fine, setFine] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const close = useCallback((refocus = false) => setOpen((o) => { if (refocus && o) o.el.focus(); return null; }), []);

  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const upd = () => { setFine(mq.matches); document.documentElement.toggleAttribute("data-own-controls", mq.matches); };
    upd();
    mq.addEventListener("change", upd);
    return () => mq.removeEventListener("change", upd);
  }, []);

  useEffect(() => {
    if (!fine) return;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) return;
      const s = eligibleSelect(e.target);
      if (s) { e.preventDefault(); s.focus(); setOpen((o) => (o?.el === s ? null : { kind: "select", el: s, seed: "" })); return; }
      const d = eligibleDate(e.target);
      if (d) { setOpen((o) => (o?.el === d ? o : { kind: "date", el: d })); return; }
      setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      const s = eligibleSelect(e.target);
      if (s) {
        const printable = e.key.length === 1 && e.key !== " " && !e.altKey;
        if (printable || e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen({ kind: "select", el: s, seed: printable ? e.key : "" });
        }
        return;
      }
      const d = eligibleDate(e.target);
      if (d && e.altKey && e.key === "ArrowDown") { e.preventDefault(); setOpen({ kind: "date", el: d }); }
      else if (d && e.key === "Escape") setOpen(null);
    };
    const onFocusIn = (e: FocusEvent) => {
      setOpen((o) => (o && e.target instanceof Node && e.target !== o.el && !popRef.current?.contains(e.target) ? null : o));
    };
    const onScroll = (e: Event) => { if (!(e.target instanceof Node && popRef.current?.contains(e.target))) setOpen(null); };
    const onResize = () => setOpen(null);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [fine]);

  if (!open || !fine || typeof document === "undefined" || !open.el.isConnected) return null;
  return createPortal(
    <Popup anchor={open.el} popRef={popRef} wide={open.kind === "select"}>
      {open.kind === "select" ? <SelectList key="s" el={open.el} seed={open.seed} close={close} /> : <Calendar key="d" el={open.el} close={close} />}
    </Popup>,
    document.body,
  );
}

function Popup({ anchor, popRef, wide, children }: { anchor: HTMLElement; popRef: React.RefObject<HTMLDivElement | null>; wide: boolean; children: React.ReactNode }) {
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const width = wide ? Math.min(Math.max(r.width, 280), window.innerWidth - 16) : 292;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const need = wide ? 320 : 372;
    const up = below < (wide ? Math.min(need, 240) : need) && above > below;
    const maxH = Math.max(160, Math.min(need, up ? above : below));
    const h = popRef.current?.offsetHeight ?? maxH;
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: up ? Math.max(8, r.top - Math.min(h, maxH) - 4) : r.bottom + 4, width, maxH });
  }, [anchor, wide, popRef, children]);
  return (
    <div ref={popRef} className="fc-pop" style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, width: pos?.width, maxHeight: pos?.maxH, opacity: pos ? 1 : 0 }}>
      {children}
    </div>
  );
}

function SelectList({ el, seed, close }: { el: HTMLSelectElement; seed: string; close: (refocus?: boolean) => void }) {
  const [q, setQ] = useState(seed);
  const items = useMemo(() => Array.from(el.options).map((o) => ({ value: o.value, label: o.label || o.text, disabled: o.disabled, group: o.parentElement instanceof HTMLOptGroupElement ? o.parentElement.label : "" })), [el]);
  const shown = useMemo(() => { const n = norm(q.trim()); return n ? items.filter((i) => norm(i.label).includes(n) || norm(i.group).includes(n)) : items; }, [items, q]);
  const [idx, setIdx] = useState(() => Math.max(0, items.findIndex((i) => i.value === el.value)));
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { listRef.current?.querySelector<HTMLElement>("[data-active=true]")?.scrollIntoView({ block: "nearest" }); }, [idx, shown]);
  const active = Math.min(idx, Math.max(0, shown.length - 1));
  const pick = (v: string) => { setNative(el, v); close(true); };
  const step = (d: number) => { let i = active; for (let n = 0; n < shown.length; n++) { i = (i + d + shown.length) % shown.length; if (!shown[i]!.disabled) break; } setIdx(i); };
  const label = el.getAttribute("aria-label") ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : null) ?? "Auswahl";
  return (
    <div className="fc-select" role="dialog" aria-label={`${label} auswählen`}>
      <input
        ref={inputRef}
        className="fc-search"
        value={q}
        placeholder={`Suchen … (${items.length})`}
        aria-label={`${label} durchsuchen`}
        role="combobox"
        aria-expanded="true"
        aria-controls="fc-list"
        aria-activedescendant={shown[active] ? `fc-opt-${active}` : undefined}
        onChange={(e) => { setQ(e.target.value); setIdx(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
          else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
          else if (e.key === "Enter") { e.preventDefault(); const it = shown[active]; if (it && !it.disabled) pick(it.value); }
          else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); close(true); }
        }}
      />
      <ul ref={listRef} id="fc-list" role="listbox" className="fc-list">
        {shown.length === 0 && <li className="fc-empty">Kein Treffer</li>}
        {shown.map((it, i) => (
          <li key={`${it.value}-${i}`}>
            {it.group && (i === 0 || shown[i - 1]!.group !== it.group) && <div className="fc-group">{it.group}</div>}
            <div id={`fc-opt-${i}`} role="option" aria-selected={it.value === el.value} aria-disabled={it.disabled || undefined} data-active={i === active} className="fc-opt" onMouseEnter={() => setIdx(i)} onMouseDown={(e) => { e.preventDefault(); if (!it.disabled) pick(it.value); }}>
              {it.label || "–"}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Calendar({ el, close }: { el: HTMLInputElement; close: (refocus?: boolean) => void }) {
  const [value, setValue] = useState(el.value);
  const sel = parse(value);
  const [view, setView] = useState(() => { const d = sel ?? new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  useEffect(() => {
    const on = () => { setValue(el.value); const d = parse(el.value); if (d && d.getFullYear() > 1900) setView(new Date(d.getFullYear(), d.getMonth(), 1)); };
    el.addEventListener("input", on);
    return () => el.removeEventListener("input", on);
  }, [el]);
  const today = iso(new Date());
  const ok = (v: string) => (!el.min || v >= el.min) && (!el.max || v <= el.max);
  const pick = (v: string) => { if (v && !ok(v)) return; setNative(el, v); close(true); };
  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const move = (n: number) => setView(new Date(view.getFullYear(), view.getMonth() + n, 1));
  const base = sel ?? new Date();
  const monthEnd = iso(new Date(base.getFullYear(), base.getMonth() + 1, 0));
  const keep = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className="fc-cal" role="dialog" aria-label="Datum wählen" onMouseDown={keep}>
      <div className="fc-cal-head">
        <button type="button" className="fc-nav" aria-label="Vorheriger Monat" onClick={() => move(-1)}>‹</button>
        <strong>{MONTHS[view.getMonth()]} {view.getFullYear()}</strong>
        <button type="button" className="fc-nav" aria-label="Nächster Monat" onClick={() => move(1)}>›</button>
      </div>
      <div className="fc-grid" aria-hidden="true">{["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((d) => <span key={d} className="fc-dow">{d}</span>)}</div>
      <div className="fc-grid">
        {days.map((d) => {
          const v = iso(d);
          return (
            <button key={v} type="button" className="fc-day" data-out={d.getMonth() !== view.getMonth() || undefined} data-today={v === today || undefined} aria-pressed={v === value} disabled={!ok(v)} aria-label={d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} onClick={() => pick(v)}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
      <div className="fc-cal-foot">
        <button type="button" className="fc-quick" onClick={() => pick(today)} disabled={!ok(today)}>Heute</button>
        <button type="button" className="fc-quick" onClick={() => pick(monthEnd)} disabled={!ok(monthEnd)}>Monatsende</button>
        {!el.required && value && <button type="button" className="fc-quick" onClick={() => pick("")}>Leeren</button>}
        <span className="fc-hint">oder tippen: TT.MM.JJJJ</span>
      </div>
    </div>
  );
}
