"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { moveOpportunityStageAction } from "../actions";
import type { BoardCard, BoardStage } from "@/modules/opportunities/board";

const LABEL: Record<BoardStage, string> = { ANTIZIPIERT: "Antizipiert", IN_KLAERUNG: "In Klärung", BESTAETIGT: "Bestätigt", PROFIL_ANGEBOT_VORGESTELLT: "Profil/Angebot vorgestellt", AUSWAHL_BESTELLUNG: "Auswahl / Bestellung", BEAUFTRAGT: "Beauftragt (60 Tage)" };
const eur = (n: number) => `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(n)} €`;

/** Pipeline-Board (e69): Spalten je Stufe; Karte ziehen ändert die Stufe, wo das ohne weitere Angaben geht. */
export function PipelineBoard({ cards, stages }: { cards: BoardCard[]; stages: readonly BoardStage[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [over, setOver] = useState<BoardStage | null>(null);
  const [local, setLocal] = useState(cards);
  const drop = (stage: BoardStage, id: string) => {
    const c = local.find((x) => x.id === id);
    setOver(null);
    if (!c || c.status === stage) return;
    const before = local;
    setLocal(local.map((x) => (x.id === id ? { ...x, status: stage } : x)));
    start(async () => {
      const r = await moveOpportunityStageAction(c.id, c.version, stage);
      setMsg({ ok: r.ok, text: r.ok ? `„${c.title}“: ${LABEL[stage]}` : r.message });
      if (!r.ok) setLocal(before);
      router.refresh();
    });
  };
  return (
    <div>
      <p className="muted text-xs mb-2" aria-live="polite">{pending ? "Speichere …" : msg ? <span style={{ color: msg.ok ? "var(--ok, #1f6b3a)" : "var(--danger)" }}>{msg.text}</span> : "Karte in eine andere Spalte ziehen, um die Stufe zu ändern. „Vorgestellt“ und „beauftragt“ entstehen über Angebot und Bestellung."}</p>
      {/* e73: alle Stufen nebeneinander – leere Spalten schmal, damit bei normaler Breite nichts waagerecht scrollt */}
      <div className="board" role="list" style={{ ["--board-cols" as string]: stages.map(() => "minmax(0, 1fr)").join(" ") }}>
        {stages.map((s) => {
          const col = local.filter((c) => c.status === s);
          const sum = col.reduce((n, c) => n + (c.vkPerDay ?? 0) * c.heads, 0);
          return (
            <section key={s} className="board-col" data-empty={col.length === 0 ? "" : undefined} data-over={over === s ? "true" : undefined} aria-label={LABEL[s]} onDragOver={(e) => { e.preventDefault(); setOver(s); }} onDragLeave={() => setOver((o) => (o === s ? null : o))} onDrop={(e) => { e.preventDefault(); drop(s, e.dataTransfer.getData("text/plain")); }}>
              <header className="board-head">
                <span className="font-semibold text-sm">{LABEL[s]}</span>
                <span className="muted text-xs">{col.length}{sum ? ` · ${eur(sum * 20)}/Monat` : ""}</span>
              </header>
              <div className="board-cards">
                {col.length === 0 && <p className="muted text-xs board-empty">–</p>}
                {col.map((c) => (
                  <article key={c.id} className="board-card" draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", c.id)} role="listitem">
                    <Link href={`/bedarfe/${c.id}`} className="board-title">{c.title}</Link>
                    <div className="muted text-xs">{c.accountName}{c.projectName && c.projectName !== "Allgemein" ? ` · ${c.projectName}` : ""}</div>
                    <div className="board-meta text-xs">
                      <span>{c.heads} {c.heads === 1 ? "Kopf" : "Köpfe"}</span>
                      {c.vkPerDay ? <span>{eur(c.vkPerDay)}/Tag</span> : null}
                      <span className="muted">{c.daysInStage} T.</span>
                    </div>
                    <div className="muted text-xs">{c.ownerName}</div>
                    {c.stageLag && <span className="chip" data-tone="warn" title="Einsatz läuft bereits – Stufe nachziehen">Einsatz läuft</span>}
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
