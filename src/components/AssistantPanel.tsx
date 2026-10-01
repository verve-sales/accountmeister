"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Assistent (Etappe 8): Seitenpanel auf jeder Seite. Kontext folgt der Adresse (Setup, Kunde, sonst allgemein).
 * Der Dialog wird gestreamt; Vorschlagskarten werden einzeln übernommen oder verworfen. Alles Fachliche läuft
 * serverseitig über die geprüften Dienste – dieses Bauteil zeigt nur an und ruft auf.
 */

const MARKER = "===KARTEN===";

type Item = Record<string, unknown> & { type: string; evidenceQuote: string };
type Card = { id: string; item: Item; status: "NEU" | "UEBERNOMMEN" | "VERWORFEN"; resultType?: string; resultId?: string; note?: string };
type Message = { id: string; role: string; text: string; cards: Card[]; missing: string[]; pending?: boolean };
type OpenPoint = { kind: string; text: string; href: string | null };
type View = {
  thread: { id: string; title: string; contextType: string; contextId: string | null; interviewMode: boolean };
  context: { label: string; canWrite: boolean };
  messages: Message[];
  openPoints: OpenPoint[];
  missing: string[];
  ai: { enabled: boolean; description: string };
};

const TYPE_LABEL: Record<string, string> = { KUNDE: "Kunde + Setup", SETUP: "Setup", PERSON: "Person", SIGNAL: "Beobachtung", CHANCE: "Chance", ACCOUNTZIEL: "Accountziel", AKTION: "Folgeaktivität", KONTAKT: "Kontaktaufnahme", FRAGE: "Offene Frage", EINSORTIERUNG: "Einsortierung", INITIATIVE: "Kundenagenda", BESCHAFFUNG: "Beschaffung", EINSATZ: "Laufender Einsatz", RISIKO: "Risiko", SOS: "SOS", HEBEL: "Hebel / Vorhaben", TEAM: "Verve-Team", VORGANG: "Vorgang / Anfrage", BESETZUNG: "Besetzung (Position)" };
const INITIATIVE_LABEL: Record<string, string> = { PRIORITAET: "Priorität des Kunden", INITIATIVE: "Schlüssel-Initiative", HERAUSFORDERUNG: "Herausforderung" };
const LEVER_LABEL: Record<string, string> = { VERLAENGERN: "Verlängern", AUSWEITEN: "Ausweiten", VERTIEFEN: "Vertiefen", UEBERTRAGEN: "Übertragen", REAKTIVIEREN: "Reaktivieren" };
const RISK_LABEL: Record<string, string> = { UMSTRUKTURIERUNG: "Umstrukturierung", BUDGETKUERZUNG: "Budgetkürzung", WETTBEWERBER: "Wettbewerber aktiv", FUERSPRECHER_WEG: "Fürsprecher geht", INSOURCING: "Insourcing", EINKAUF_VERSCHAERFT: "Einkauf verschärft", NACHBARTEAM: "Nachbarteam stellt sich quer" };
const PROCUREMENT_LABEL: Record<string, string> = { DIREKT: "direkt", VERMITTLER: "über Vermittler", RAHMENVERTRAG: "über Rahmenvertrag" };
/** Reihenfolge für „Alle übernehmen“: erst Kunde/Einsortierung (bindet das Gespräch), dann Team, dann der Rest. */
const APPLY_ORDER = ["KUNDE", "EINSORTIERUNG", "SETUP", "TEAM", "BESCHAFFUNG", "INITIATIVE", "PERSON", "EINSATZ", "CHANCE", "HEBEL", "RISIKO", "SOS", "SIGNAL", "AKTION", "KONTAKT", "FRAGE", "ACCOUNTZIEL", "VORGANG", "BESETZUNG"];
const ROLE_FAMILY_LABEL: Record<string, string> = { DELIVERY_MANAGEMENT: "Delivery Management", AGILE_LEADERSHIP: "Agile Leadership", BUSINESS_ANALYSE: "Business Analyse & Beratung", SOLUTION_ARCHITEKTUR: "Solution & Architektur", TEST_QS: "Test & Qualitätssicherung" };

function contextFromPath(pathname: string): { type: string; id: string } {
  const setup = /^\/setups\/([^/]+)/.exec(pathname);
  if (setup) return { type: "SETUP", id: setup[1]! };
  const account = /^\/kunden\/([^/]+)/.exec(pathname);
  if (account && account[1] !== "anlage") return { type: "ACCOUNT", id: account[1]! };
  return { type: "GLOBAL", id: "" };
}

function cardTitle(item: Item): string {
  const s = (k: string) => String(item[k] ?? "");
  switch (item.type) {
    case "KUNDE":
      return `${s("name")} → Setup „${s("setupName")}“`;
    case "SETUP":
      return s("name");
    case "PERSON":
      return `${s("displayName")}${s("functionTitle") ? ` – ${s("functionTitle")}` : ""}`;
    case "SIGNAL":
      return s("observation");
    case "CHANCE":
      return s("title");
    case "ACCOUNTZIEL":
      return s("title");
    case "AKTION":
      return `${s("title")}${s("ownerRole") ? ` (${s("ownerRole")})` : ""}${s("dueHint") ? ` · ${s("dueHint")}` : ""}`;
    case "KONTAKT":
      return `${s("personName")} – ${s("occasion")}`;
    case "FRAGE":
      return s("question");
    case "EINSORTIERUNG":
      return `→ ${s("accountName")}${s("setupName") ? ` · ${s("setupName")}` : ""}`;
    case "INITIATIVE":
      return `${INITIATIVE_LABEL[s("kind")] ?? s("kind")}: ${s("title")}`;
    case "BESCHAFFUNG":
      return `Beschaffung ${PROCUREMENT_LABEL[s("channel")] ?? s("channel")}${s("intermediaryName") ? `: ${s("intermediaryName")}` : ""}`;
    case "EINSATZ":
      return `${s("title")}${s("plannedEnd") || s("endHint") ? ` · Ende ${s("plannedEnd") || s("endHint")}` : ""}`;
    case "RISIKO":
      return RISK_LABEL[s("risk")] ?? s("risk");
    case "SOS":
      return s("title");
    case "HEBEL":
      return `${LEVER_LABEL[s("lever")] ?? s("lever")}: ${s("title")}`;
    case "TEAM": {
      const ank = Array.isArray(item.ankerNames) ? (item.ankerNames as string[]).join(", ") : "";
      return [s("bdName") && `BD ${s("bdName")}`, ank && `Anker ${ank}`, s("principalName") && `Principal ${s("principalName")}`, s("consultantName") && `Berater ${s("consultantName")}`].filter(Boolean).join(" · ") || "Team";
    }
    case "VORGANG": {
      const to: Record<string, string> = { ICH: "für mich", SALES_OPS: "an Sales Operations", BD: "an den BD", PRINCIPAL: "an Principal", PERSON: `an ${s("personName") || "Person"}` };
      return `${s("title")} (${to[s("target")] ?? s("target")})`;
    }
    case "BESETZUNG":
      return `${s("title")} – ${s("resourceKind") === "INTERN" ? "intern" : "Freelancer"}${s("personName") ? `: ${s("personName")}` : " (Person offen)"}`;
    default:
      return item.type;
  }
}

/** Übernahme-Hinweis mit anklickbaren Pfaden (z. B. /einsaetze/…). */
function NoteText({ text }: { text: string }) {
  const parts = text.split(/(\/(?:einsaetze|besetzung|bedarfe|vorgaenge)\/[\w-]+)/g);
  return <>{parts.map((p, i) => (/^\/(einsaetze|besetzung|bedarfe|vorgaenge)\//.test(p) ? <a key={i} href={p}>{p.startsWith("/einsaetze") ? "Einsatz öffnen" : p.startsWith("/besetzung") ? "Position öffnen" : p.startsWith("/bedarfe") ? "Chance öffnen" : "Vorgang öffnen"}</a> : <span key={i}>{p}</span>))}</>;
}

function cardDetail(item: Item): string {
  const s = (k: string) => String(item[k] ?? "");
  switch (item.type) {
    case "PERSON": {
      const parts = [s("email"), s("phone"), s("knownResponsibility"), s("decisionRole") && s("decisionRole") !== "null" ? `Rolle: ${s("decisionRole")}` : "", s("stance") !== "UNBEKANNT" ? `Haltung: ${s("stance")}` : "", s("influence") !== "UNBEKANNT" ? `Einfluss: ${s("influence")}` : "", s("assessmentNote")];
      return parts.filter(Boolean).join(" · ");
    }
    case "SIGNAL":
      return s("relevanceHypothesis") ? `Vermutung: ${s("relevanceHypothesis")}` : "";
    case "BESETZUNG": {
      const unit: Record<string, string> = { TAGE_PRO_WOCHE: "Tage/Woche", STUNDEN_PRO_WOCHE: "Std/Woche", PROZENT: "%" };
      const meta = [s("desiredStart") && `Start ${s("desiredStart")}`, item.endOpen ? "Ende offen" : s("plannedEnd") && `Ende ${s("plannedEnd")}`, s("scopeAmount") && s("scopeAmount") !== "null" ? `${s("scopeAmount")} ${unit[s("scopeUnit")] ?? ""}` : "", s("location"), s("language"), s("chanceTitle") && `Chance: ${s("chanceTitle")}`].filter(Boolean).join(" · ");
      return [meta, s("mustHave") && `Muss: ${s("mustHave")}`, s("tasks") && `Aufgaben: ${s("tasks")}`].filter(Boolean).join("\n");
    }
    case "CHANCE": {
      const kind: Record<string, string> = { VERVE_EXPERTE: "Verve-Experte", FREELANCER_EXPERTE: "Freelancer-Experte", AUSSCHREIBUNG: "Ausschreibung" };
      const meta = [kind[s("kind")] ?? s("kind"), s("roleName"), s("headcount") && s("headcount") !== "null" ? `${s("headcount")}×` : "", s("horizon"), item.anticipated === false ? "vom Kunden ausgesprochen" : "antizipiert"].filter(Boolean).join(" · ");
      return `${meta}\n${s("needDescription")}`;
    }
    case "ACCOUNTZIEL": {
      const meta = [s("roleFamily") && s("roleFamily") !== "null" ? ROLE_FAMILY_LABEL[s("roleFamily")] ?? s("roleFamily") : "", s("targetHeadcount") && s("targetHeadcount") !== "null" ? `${s("targetHeadcount")}×` : "", s("horizon")].filter(Boolean).join(" · ");
      return `${meta}\n${s("desiredOutcome")}${s("successCriterion") ? `\nErfolgskriterium: ${s("successCriterion")}` : ""}`;
    }
    case "AKTION":
      return s("description");
    case "KONTAKT":
      return `${s("viaVerveName") ? `Über ${s("viaVerveName")}. ` : ""}${s("draftMessage") ? `Entwurf: ${s("draftMessage")}` : ""}`;
    case "KUNDE":
    case "SETUP":
      return s("contextNote");
    case "EINSORTIERUNG":
      return s("reasoning");
    case "INITIATIVE":
      return s("description");
    case "BESCHAFFUNG":
    case "RISIKO":
      return s("note");
    case "EINSATZ":
      return s("consultantName") ? `Operativer Berater: ${s("consultantName")}` : "";
    case "SOS":
      return `${s("situation")}${s("need") ? `\nWas hilft: ${s("need")}` : ""}`;
    case "HEBEL":
      return s("rationale");
    default:
      return "";
  }
}

export function AssistantPanel(props: { signedIn: boolean }) {
  // useSearchParams braucht eine Suspense-Grenze im Layout.
  return (
    <Suspense fallback={null}>
      <AssistantPanelInner {...props} />
    </Suspense>
  );
}

function AssistantPanelInner({ signedIn }: { signedIn: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const [view, setView] = useState<View | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const ctx = useMemo(() => contextFromPath(pathname ?? "/"), [pathname]);

  // Öffnen per Adresse (?assistent=1 bzw. ?assistent=interview), z. B. von den Schaltflächen „Mit dem Assistenten erfassen“.
  const searchParams = useSearchParams();
  const wanted = searchParams?.get("assistent") ?? null;
  const urlKey = `${pathname}?assistent=${wanted ?? ""}`;
  const [manual, setManual] = useState<{ key: string; open: boolean } | null>(null);
  const open = manual && manual.key === urlKey ? manual.open : wanted ? true : (manual?.open ?? false);
  const setOpen = (fn: (o: boolean) => boolean) => setManual({ key: urlKey, open: fn(open) });
  const wantInterview = useRef<string | null>(null);
  if (wanted === "interview" && wantInterview.current !== urlKey) wantInterview.current = urlKey;

  const load = useCallback(async () => {
    const res = await fetch(`/api/assistent?type=${ctx.type}&id=${encodeURIComponent(ctx.id)}`, { cache: "no-store" });
    if (!res.ok) {
      setError((await res.json().catch(() => ({ error: "Fehler" }))).error ?? "Fehler");
      return;
    }
    let v = (await res.json()) as View;
    if (wantInterview.current && !v.thread.interviewMode) {
      wantInterview.current = null;
      const r2 = await fetch("/api/assistent/modus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: v.thread.id, interviewMode: true }) });
      if (r2.ok) {
        const again = await fetch(`/api/assistent?type=${ctx.type}&id=${encodeURIComponent(ctx.id)}`, { cache: "no-store" });
        if (again.ok) v = (await again.json()) as View;
      }
    }
    wantInterview.current = null;
    setView(v);
    setMessages(v.messages);
  }, [ctx.type, ctx.id]);

  // Laden beim Öffnen und bei Kontextwechsel (Seite gewechselt, Panel offen) – aus dem Ereignis heraus, nicht aus einem Effekt.
  const loadedKey = useRef<string | null>(null);
  const key = `${ctx.type}:${ctx.id}:${wanted ?? ""}`;
  if (open && signedIn && loadedKey.current !== key) {
    loadedKey.current = key;
    queueMicrotask(() => {
      load().catch((e: unknown) => setError(e instanceof Error ? e.message : "Fehler"));
    });
  }

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function send() {
    if (!view || !text.trim() || busy) return;
    const userText = text.trim();
    setText("");
    setBusy(true);
    setError(null);
    const tempId = `tmp-${Date.now()}`;
    setMessages((m) => [...m, { id: `u-${tempId}`, role: "NUTZER", text: userText, cards: [], missing: [] }, { id: tempId, role: "ASSISTENT", text: "", cards: [], missing: [], pending: true }]);
    try {
      const res = await fetch("/api/assistent/nachricht", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: view.thread.id, text: userText }) });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: "Fehler" }));
        throw new Error(j.error ?? "Fehler");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let prose = "";
      let tail: string | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (tail === null) {
          const idx = buffer.indexOf(MARKER);
          if (idx >= 0) {
            prose = buffer.slice(0, idx);
            tail = buffer.slice(idx + MARKER.length);
          } else {
            const keep = MARKER.length - 1;
            prose = buffer.length > keep ? buffer.slice(0, buffer.length - keep) : "";
          }
          const shown = prose;
          setMessages((m) => m.map((x) => (x.id === tempId ? { ...x, text: shown } : x)));
        } else {
          tail = buffer.slice(buffer.indexOf(MARKER) + MARKER.length);
        }
      }
      if (tail === null) {
        const idx = buffer.indexOf(MARKER);
        prose = idx >= 0 ? buffer.slice(0, idx) : buffer;
        tail = idx >= 0 ? buffer.slice(idx + MARKER.length) : "";
      }
      let payload: { message?: { id: string; text: string }; cards?: Card[]; missing?: string[]; error?: string } = {};
      try {
        payload = JSON.parse(tail.trim() || "{}");
      } catch {
        payload = {};
      }
      if (payload.error) throw new Error(payload.error);
      setMessages((m) => m.map((x) => (x.id === tempId ? { id: payload.message?.id ?? tempId, role: "ASSISTENT", text: payload.message?.text ?? prose.trim(), cards: payload.cards ?? [], missing: payload.missing ?? [] } : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fehler");
      setMessages((m) => m.filter((x) => x.id !== tempId));
    } finally {
      setBusy(false);
    }
  }

  async function decide(messageId: string, cardId: string, decision: "UEBERNEHMEN" | "VERWERFEN", quiet = false): Promise<{ ok: boolean; thread?: { contextType: string; contextId: string | null } }> {
    if (!view) return { ok: false };
    setError(null);
    const res = await fetch("/api/assistent/karte", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: view.thread.id, messageId, cardId, decision }) });
    const j = await res.json().catch(() => ({ error: "Fehler" }));
    if (!res.ok) {
      setError(j.error ?? "Fehler");
      return { ok: false };
    }
    setMessages((m) => m.map((x) => (x.id === messageId ? { ...x, cards: x.cards.map((c) => (c.id === cardId ? (j.card as Card) : c)) } : x)));
    if (quiet) return { ok: true, thread: j.thread };
    if (j.thread && j.thread.contextType !== view.thread.contextType) {
      // Gespräch wurde an ein neues Setup gebunden: dorthin wechseln
      setView({ ...view, thread: { ...view.thread, ...j.thread } });
      if (j.thread.contextType === "SETUP" && j.thread.contextId) router.push(`/setups/${j.thread.contextId}`);
    } else {
      router.refresh();
    }
    return { ok: true };
  }

  /** Alle offenen Karten einer Antwort nacheinander übernehmen – Kunde zuerst; bei einem Fehler anhalten. */
  async function acceptAll(messageId: string) {
    const msg = messages.find((x) => x.id === messageId);
    if (!msg || !view || busy) return;
    const open = msg.cards.filter((c) => c.status === "NEU").sort((a, b) => APPLY_ORDER.indexOf(a.item.type) - APPLY_ORDER.indexOf(b.item.type));
    setBusy(true);
    let lastThread: { contextType: string; contextId: string | null } | undefined;
    let failed = 0;
    try {
      for (const c of open) {
        const r = await decide(messageId, c.id, "UEBERNEHMEN", true);
        if (!r.ok) failed++;
        if (r.thread) lastThread = r.thread;
      }
    } finally {
      setBusy(false);
    }
    if (failed) setError(`${failed} Karte(n) konnten nicht übernommen werden – Hinweis steht an der Karte bzw. oben; bitte einzeln prüfen.`);
    if (lastThread && lastThread.contextType === "SETUP" && lastThread.contextId && lastThread.contextType !== view.thread.contextType) {
      setView({ ...view, thread: { ...view.thread, ...lastThread } });
      router.push(`/setups/${lastThread.contextId}`);
    } else router.refresh();
  }

  async function toggleInterview() {
    if (!view || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/assistent/modus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: view.thread.id, interviewMode: !view.thread.interviewMode }) });
      if (res.ok) await load();
      else setError((await res.json().catch(() => ({ error: "Fehler" }))).error ?? "Fehler");
    } finally {
      setBusy(false);
    }
  }

  async function newThread() {
    if (!view || busy) return;
    setBusy(true);
    setView(null);
    setMessages([]);
    try {
      await fetch("/api/assistent/neu", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: view.thread.id }) });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn) return null;

  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="assistent-panel" style={{ position: "fixed", right: "1rem", bottom: "1rem", zIndex: 40, boxShadow: "0 2px 8px rgba(0,0,0,.15)" }}>
        {open ? "Assistent schließen" : "Assistent"}
      </button>
      {open && (
        <aside id="assistent-panel" aria-label="Assistent" className="card" style={{ position: "fixed", right: "1rem", bottom: "4rem", top: "4.5rem", width: "min(440px, calc(100vw - 2rem))", zIndex: 40, display: "flex", flexDirection: "column", padding: 0, boxShadow: "0 4px 24px rgba(0,0,0,.18)" }}>
          <div className="px-4 py-2 border-b flex items-center gap-2" style={{ borderColor: "var(--border)" }}>
            <strong className="text-sm">Assistent</strong>
            <span className="muted text-xs truncate">{view?.context.label ?? "…"}</span>
            <span className="ml-auto flex gap-2">
              <button type="button" className="btn btn-secondary btn-small" onClick={toggleInterview} disabled={!view} title="Der Assistent führt aktiv durch die Erfassung">
                {view?.thread.interviewMode ? "Interview: an" : "Interview"}
              </button>
              <button type="button" className="btn btn-secondary btn-small" onClick={newThread} disabled={!view} title="Neues Gespräch (altes bleibt als Quelle erhalten)">
                Neu
              </button>
            </span>
          </div>

          <div ref={listRef} className="px-4 py-3 space-y-3" style={{ overflowY: "auto", flex: 1 }}>
            {view && (view.openPoints.length > 0 || view.missing.length > 0) && messages.length === 0 && (
              <div className="text-sm" style={{ background: "#fafaf8", border: "1px solid var(--border)", borderRadius: 8, padding: ".6rem .8rem" }}>
                {view.openPoints.length > 0 && (
                  <>
                    <div className="font-medium mb-1">Offene Punkte</div>
                    <ul className="space-y-1 mb-2">
                      {view.openPoints.map((p, i) => (
                        <li key={i}>{p.href ? <a href={p.href}>{p.text}</a> : p.text}</li>
                      ))}
                    </ul>
                  </>
                )}
                {view.missing.length > 0 && (
                  <>
                    <div className="font-medium mb-1">Damit ich Vorschläge machen kann</div>
                    <ul className="space-y-1">
                      {view.missing.map((m, i) => (
                        <li key={i} className="muted">{m}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
            {messages.length === 0 && view && view.openPoints.length === 0 && view.missing.length === 0 && <p className="muted text-sm">Erzähl mir, was du weißt – ich schlage vor, was daraus angelegt werden kann.</p>}

            {messages.map((m) => (
              <div key={m.id} className={m.role === "NUTZER" ? "pl-8" : ""}>
                <div className="muted text-xs">{m.role === "NUTZER" ? "Ich" : "Assistent"}</div>
                <div className="text-sm" style={{ whiteSpace: "pre-wrap" }}>
                  {m.text}
                  {m.pending && <span className="muted"> ▍</span>}
                </div>
                {m.missing.length > 0 && (
                  <ul className="text-xs muted mt-1 space-y-0.5">
                    {m.missing.map((q, i) => <li key={i}>Fehlt: {q}</li>)}
                  </ul>
                )}
                {m.cards.filter((c) => c.status === "NEU").length > 1 && view?.context.canWrite && (
                  <div className="mt-2 flex items-center gap-2">
                    <button type="button" className="btn btn-small" disabled={busy} onClick={() => void acceptAll(m.id)}>Alle {m.cards.filter((c) => c.status === "NEU").length} übernehmen</button>
                    <span className="muted text-xs">Kunde zuerst, dann der Rest – einzeln verwerfen geht vorher.</span>
                  </div>
                )}
                {m.cards.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {m.cards.map((c) => (
                      <li key={c.id} className="text-sm" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: ".5rem .7rem", background: c.status === "UEBERNOMMEN" ? "#f2f9f2" : c.status === "VERWORFEN" ? "#f7f7f5" : "var(--surface)", opacity: c.status === "VERWORFEN" ? 0.7 : 1 }}>
                        <div className="flex items-baseline gap-2">
                          <span className="status">{TYPE_LABEL[c.item.type] ?? c.item.type}</span>
                          <span className="font-medium">{cardTitle(c.item)}</span>
                        </div>
                        {cardDetail(c.item) && <div className="muted text-xs mt-1" style={{ whiteSpace: "pre-wrap" }}>{cardDetail(c.item)}</div>}
                        {"purpose" in c.item && (c.item.purpose ? <div className="text-xs mt-1"><span className="muted">Wofür: </span>{String(c.item.purpose)}</div> : <div className="text-xs mt-1" style={{ color: "#8a6d1f" }}>Wofür unklar – nur übernehmen, wenn du den Zweck kennst.</div>)}
                        <div className="muted text-xs mt-1">Textstelle: „{c.item.evidenceQuote.length > 120 ? c.item.evidenceQuote.slice(0, 117) + "…" : c.item.evidenceQuote}“</div>
                        {c.status === "NEU" && view?.context.canWrite && (
                          <div className="flex gap-2 mt-2">
                            <button type="button" className="btn btn-small" onClick={() => decide(m.id, c.id, "UEBERNEHMEN")}>Übernehmen</button>
                            <button type="button" className="btn btn-secondary btn-small" onClick={() => decide(m.id, c.id, "VERWERFEN")}>Verwerfen</button>
                          </div>
                        )}
                        {c.status === "NEU" && view && !view.context.canWrite && <div className="muted text-xs mt-1">Zum Übernehmen fehlt das Bearbeitungsrecht in diesem Kontext.</div>}
                        {c.status !== "NEU" && <div className="text-xs mt-1">{c.status === "UEBERNOMMEN" ? <>Übernommen. <NoteText text={c.note ?? ""} /></> : "Verworfen."}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {error && <p className="error text-sm" role="alert">{error}</p>}
          </div>

          <form
            className="px-4 py-3 border-t"
            style={{ borderColor: "var(--border)" }}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              className="textarea"
              style={{ minHeight: "4.5rem" }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={view?.thread.interviewMode ? "Antworte in eigenen Worten – gern mehrere Dinge auf einmal." : "Was weißt du, was ist passiert, was brauchst du? (Enter sendet, Shift+Enter neue Zeile)"}
              disabled={busy || !view}
              aria-label="Nachricht an den Assistenten"
            />
            <div className="flex items-center gap-3 mt-2">
              <button className="btn btn-small" type="submit" disabled={busy || !text.trim() || !view}>{busy ? "…" : "Senden"}</button>
              <span className="muted text-xs">{view ? (view.ai.enabled ? "Vorschläge sind Vorschläge – nichts wird ohne Klick angelegt. Diktieren: Win + H." : "KI deaktiviert – der Assistent zeigt offene Punkte und fehlende Angaben.") : ""}</span>
            </div>
          </form>
        </aside>
      )}
    </>
  );
}
