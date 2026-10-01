"use client";

import { Fragment, useMemo, useState } from "react";
import { computeDeal, FREELANCER, INTERNAL_ROLES, legendFor, type DealInput, type ProvisionConfig, type Recipient } from "@/modules/provision/model";

type Row = DealInput & { id: number; name: string };

const eur = (n: number) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const pct = (n: number) => `${(n * 100).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));

const TIER_COLOR: Record<string, string> = { KEINE: "#c0392b", BASIS: "#d68910", STANDARD: "#2f7d32", PREMIUM: "#2f7d32", PRINCIPAL: "#1f5fa8" };

let nextId = 1;
const emptyRow = (): Row => ({ id: nextId++, name: "", profile: FREELANCER, ek: null, vk: null, days: null, findingShare: 100, signingShare: 100 });

/** Provisionsrechner zum freien Ausfüllen – rechnet nur im Browser, speichert nichts. */
export function ProvisionCalculator({ isPrincipal, config }: { isPrincipal: boolean; config: ProvisionConfig }) {
  const PROVISION_CONFIG = config;
  const [recipient, setRecipient] = useState<Recipient>(isPrincipal ? "PRINCIPAL" : "BD");
  const [rows, setRows] = useState<Row[]>(() => [emptyRow()]);
  const results = useMemo(() => rows.map((r) => computeDeal(r, recipient, config)), [rows, recipient, config]);
  const legend = useMemo(() => legendFor(recipient, config), [recipient, config]);
  const set = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const totals = results.reduce((a, r) => (r ? { base: a.base + r.baseCommission, finding: a.finding + r.findingFee, signing: a.signing + r.signingFee, total: a.total + r.total, net: a.net + r.netMargin, revenue: a.revenue + r.revenue } : a), { base: 0, finding: 0, signing: 0, total: 0, net: 0, revenue: 0 });

  return (
    <div className="space-y-4">
      <section className="card">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">Berechnet für:</span>
          {isPrincipal ? (
            <>
              <label className="text-sm flex items-center gap-1"><input type="radio" name="rcp" checked={recipient === "PRINCIPAL"} onChange={() => setRecipient("PRINCIPAL")} /> Principal (alle Stufen)</label>
              <label className="text-sm flex items-center gap-1"><input type="radio" name="rcp" checked={recipient !== "PRINCIPAL"} onChange={() => setRecipient("BD")} /> BD / Anker (höchstens 20 %)</label>
            </>
          ) : (
            <strong className="text-sm">BD / Anker</strong>
          )}
          <span className="muted text-xs ml-auto">Kostenpauschale {PROVISION_CONFIG.costTiers[0]!.perDay} €/Tag · Finding Fee {eur(PROVISION_CONFIG.findingFee)} · Signing Fee {eur(PROVISION_CONFIG.signingFee)} je Deal</span>
        </div>
      </section>

      <section className="card" style={{ overflowX: "auto" }}>
        <table className="list" style={{ minWidth: 860 }}>
          <thead>
            <tr>
              <th>Deal / Person</th>
              <th>Profil</th>
              <th>EK €/Tag</th>
              <th>VK €/Tag</th>
              <th>Einsatz&shy;tage</th>
              <th>Anteil Finding Fee</th>
              <th>Anteil Signing Fee</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const res = results[i];
              const internal = INTERNAL_ROLES.find((x) => x.key === r.profile);
              return (
                <Fragment key={r.id}>
                <tr style={{ verticalAlign: "top" }}>
                  <td><input className="input" value={r.name} onChange={(e) => set(r.id, { name: e.target.value })} placeholder={`Deal ${i + 1}`} aria-label="Bezeichnung" style={{ width: "9rem" }} /></td>
                  <td>
                    <select className="select" value={r.profile} onChange={(e) => set(r.id, { profile: e.target.value })} aria-label="Profil" style={{ width: "11rem" }}>
                      <option value={FREELANCER}>Freelancer</option>
                      <optgroup label="Interne Rolle (EK fest)">
                        {INTERNAL_ROLES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                      </optgroup>
                    </select>
                  </td>
                  <td>
                    {internal ? <span className="text-sm" title="Fester EK der internen Rolle">{internal.ek.toLocaleString("de-DE")} (fest)</span> : <input className="input" inputMode="decimal" value={r.ek ?? ""} onChange={(e) => set(r.id, { ek: num(e.target.value) })} aria-label="EK pro Tag" style={{ width: "6rem" }} />}
                  </td>
                  <td><input className="input" inputMode="decimal" value={r.vk ?? ""} onChange={(e) => set(r.id, { vk: num(e.target.value) })} aria-label="VK pro Tag" style={{ width: "6rem" }} /></td>
                  <td><input className="input" inputMode="decimal" value={r.days ?? ""} onChange={(e) => set(r.id, { days: num(e.target.value) })} aria-label="Einsatztage" style={{ width: "5rem" }} /></td>
                  <td><span className="flex items-center gap-1"><input className="input" inputMode="decimal" value={r.findingShare ?? ""} onChange={(e) => set(r.id, { findingShare: num(e.target.value) })} aria-label="Anteil Finding Fee in Prozent" style={{ width: "4.5rem" }} />%</span></td>
                  <td><span className="flex items-center gap-1"><input className="input" inputMode="decimal" value={r.signingShare ?? ""} onChange={(e) => set(r.id, { signingShare: num(e.target.value) })} aria-label="Anteil Signing Fee in Prozent" style={{ width: "4.5rem" }} />%</span></td>
                  <td>{rows.length > 1 && <button type="button" className="btn btn-secondary btn-small" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} aria-label="Zeile entfernen">×</button>}</td>
                </tr>
                <tr>
                  <td colSpan={8} style={{ borderTop: "none", paddingTop: 0 }}>
                    {res ? (
                      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}>
                        {[
                          ["Nettomarge %", pct(res.netMarginPct), TIER_COLOR[res.tierKey]],
                          ["Provisionssatz", pct(res.rate)],
                          ["Basisprovision", eur(res.baseCommission)],
                          ["Finding Fee", eur(res.findingFee)],
                          ["Signing Fee", eur(res.signingFee)],
                          ["Provision gesamt", eur(res.total)],
                        ].map(([label, value, color], k) => (
                          <div key={k} style={{ background: k === 5 ? "var(--accent-soft)" : "var(--surface-2, #f6f6f4)", borderRadius: 8, padding: ".4rem .6rem" }}>
                            <div className="muted text-xs">{label}</div>
                            <div style={{ fontWeight: 600, color: color ?? undefined, whiteSpace: "nowrap" }}>{value}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="muted text-sm">EK, VK und Einsatztage eintragen – dann erscheint die Provision.</span>
                    )}
                    {res && res.warnings.length > 0 && <div className="text-xs mt-1" style={{ color: "#8a6d1f" }}>{res.warnings.join(" ")}</div>}
                  </td>
                </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-4 mt-3">
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setRows((rs) => [...rs, emptyRow()])}>Deal hinzufügen</button>
          {results.filter(Boolean).length > 1 && (
            <span className="text-sm">Gesamt: Nettomarge {totals.revenue ? pct(totals.net / totals.revenue) : "–"} · Basisprovision {eur(totals.base)} · Finding Fee {eur(totals.finding)} · Signing Fee {eur(totals.signing)} · <strong>Provision gesamt {eur(totals.total)}</strong></span>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Legende</h2>
        <ul className="text-sm space-y-1">
          {legend.map((l) => (
            <li key={l.text} className="flex gap-2 items-baseline"><span className="status" style={{ minWidth: "4.5rem", textAlign: "center" }}>{l.color}</span><span>{l.text}</span></li>
          ))}
        </ul>
        <p className="muted text-xs mt-3">Formeln: Kosten = gestaffelte Kostenpauschale je Einsatztag (Tag 1–50, 51–100, ab 101: je {PROVISION_CONFIG.costTiers[0]!.perDay} €). Nettomarge = Tage × (VK − EK) − Kosten; Nettomarge % = Nettomarge / Umsatz. Provision gesamt = Nettomarge × Satz + Finding Fee + Signing Fee (jeweils mit deinem Anteil). Der Rechner speichert nichts – die Werte verschwinden beim Verlassen der Seite. Verbindlich ist die Abrechnung, nicht dieser Rechner.</p>
      </section>
    </div>
  );
}
