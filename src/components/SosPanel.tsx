import Link from "next/link";
import { changeSosStatusAction, createSosAction } from "@/app/actions";
import { sosKindLabel, sosKindValues, sosStatusLabel, type SosKind } from "@/modules/sos/service";
import { fmtDate } from "@/lib/labels";

type Sos = { id: string; kind: string; title: string; situation: string; need: string | null; status: string; urgency: string; resolution: string | null; version: number; createdAt: Date; accountId: string; accountName?: string };

const SOS_BG = "#fdecec";
const SOS_BORDER = "#c0392b";

function SosItem({ s, back, canEdit, showAccount }: { s: Sos; back: string; canEdit: boolean; showAccount?: boolean }) {
  return (
    <li className="text-sm" style={{ borderLeft: `4px solid ${s.status === "GELOEST" ? "var(--border)" : SOS_BORDER}`, paddingLeft: ".6rem" }}>
      <div className="flex flex-wrap items-baseline gap-2">
        <strong>{s.title}</strong>
        <span className="muted text-xs">{sosKindLabel[s.kind as SosKind] ?? s.kind} · {sosStatusLabel[s.status] ?? s.status} · seit {fmtDate(s.createdAt)}</span>
        {showAccount && <Link href={`/kunden/${s.accountId}#sos`} className="text-xs">{s.accountName}</Link>}
      </div>
      <div style={{ whiteSpace: "pre-wrap" }}>{s.situation}</div>
      {s.need && <div className="text-xs">Was hilft: {s.need}</div>}
      {s.resolution && <div className="text-xs muted">Lösung: {s.resolution}</div>}
      {canEdit && s.status !== "GELOEST" && (
        <form action={changeSosStatusAction} className="flex flex-wrap gap-2 mt-1 items-center">
          <input type="hidden" name="sosId" value={s.id} />
          <input type="hidden" name="version" value={s.version} />
          <input type="hidden" name="back" value={back} />
          {s.status === "OFFEN" && <button className="btn btn-secondary btn-small" name="status" value="IN_BEARBEITUNG" type="submit">Ich kümmere mich</button>}
          <input name="resolution" className="input" placeholder="Wie wurde es gelöst?" style={{ maxWidth: 320 }} />
          <button className="btn btn-small" name="status" value="GELOEST" type="submit">Gelöst</button>
        </form>
      )}
    </li>
  );
}

/** SOS-Protokolle am Kunden: auslösen und bearbeiten. */
export function SosPanel({ accountId, sos, back, canEdit, setups, orders }: { accountId: string; sos: Sos[]; back: string; canEdit: boolean; setups: { id: string; name: string }[]; orders: { id: string; title: string }[] }) {
  const open = sos.filter((s) => s.status !== "GELOEST");
  const done = sos.filter((s) => s.status === "GELOEST");
  return (
    <section className="card" id="sos" style={open.length ? { background: SOS_BG, borderColor: SOS_BORDER } : undefined}>
      <div className="flex flex-wrap items-baseline gap-2 mb-1">
        <h2 className="font-semibold">SOS-Protokolle{open.length ? ` – ${open.length} offen` : ""}</h2>
        <span className="muted text-xs">Wenn es eng wird: Einsatz läuft ohne Anschluss aus, der Anker kommt nicht weiter, die Lage spitzt sich zu.</span>
      </div>
      {open.length > 0 && <ul className="space-y-3 mb-2">{open.map((s) => <SosItem key={s.id} s={s} back={back} canEdit={canEdit} />)}</ul>}
      {open.length === 0 && <p className="muted text-sm">Kein offenes SOS.</p>}
      {done.length > 0 && (
        <details className="text-sm">
          <summary>Gelöst ({done.length})</summary>
          <ul className="space-y-2 mt-2">{done.map((s) => <SosItem key={s.id} s={s} back={back} canEdit={false} />)}</ul>
        </details>
      )}
      <details className="mt-2">
        <summary>SOS auslösen</summary>
        <form action={createSosAction} className="grid sm:grid-cols-2 gap-3 mt-2">
          <input type="hidden" name="accountId" value={accountId} />
          <input type="hidden" name="back" value={back} />
          <div>
            <label className="label" htmlFor="sosKind">Worum geht es?</label>
            <select id="sosKind" name="kind" className="select" defaultValue="ANKER_BLOCKIERT">
              {sosKindValues.map((k) => <option key={k} value={k}>{sosKindLabel[k]}</option>)}
            </select>
          </div>
          <div><label className="label" htmlFor="sosTitle">Kurz benannt</label><input id="sosTitle" name="title" className="input" required minLength={3} /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="sosSit">Lage (was ist passiert, seit wann?)</label><textarea id="sosSit" name="situation" className="textarea" rows={3} required minLength={10} /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="sosNeed">Was brauchst du? Wer soll helfen?</label><input id="sosNeed" name="need" className="input" /></div>
          {setups.length > 0 && (
            <div>
              <label className="label" htmlFor="sosSetup">Setup (optional)</label>
              <select id="sosSetup" name="setupId" className="select" defaultValue="">
                <option value="">–</option>
                {setups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          {orders.length > 0 && (
            <div>
              <label className="label" htmlFor="sosOrder">Einsatz (optional)</label>
              <select id="sosOrder" name="orderId" className="select" defaultValue="">
                <option value="">–</option>
                {orders.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
              </select>
            </div>
          )}
          <div className="sm:col-span-2"><button className="btn" type="submit" style={{ background: SOS_BORDER, borderColor: SOS_BORDER }}>SOS auslösen</button></div>
        </form>
      </details>
    </section>
  );
}

/** Startseite: offene SOS unübersehbar oben. */
export function SosBanner({ sos }: { sos: Sos[] }) {
  if (!sos.length) return null;
  return (
    <section className="card" style={{ background: SOS_BG, borderColor: SOS_BORDER, borderWidth: 2 }}>
      <h2 className="font-semibold mb-2" style={{ color: SOS_BORDER }}>SOS – {sos.length} offen</h2>
      <ul className="space-y-3">{sos.map((s) => <SosItem key={s.id} s={s} back="/start" canEdit={false} showAccount />)}</ul>
      <p className="muted text-xs mt-2">Bearbeiten und lösen auf der Kundenseite (Abschnitt „SOS-Protokolle“).</p>
    </section>
  );
}
