import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError } from "@/lib/errors";
import type { Actor } from "@/modules/identity/actor";
import { hasRole } from "@/modules/identity/actor";
import { getMocoClient, isInternalMocoCompany, mocoDealUrl, mocoEnabled, mocoProjectUrl, type MocoFullClient } from "@/modules/moco/client";
import type { SpClient } from "@/modules/sharepoint/client";
import { todayIso } from "@/modules/work/calendar";

/**
 * Täglicher Abgleich (e74, Konzept „Abgleich und Umstellung“): Der Accountmeister vergleicht seine Vorgänge mit Moco und
 * SharePoint und meldet Abweichungen – er schreibt dabei nie zurück (R1 Feldhoheit). Einzige Ausnahme: eine Ablage in
 * SharePoint, die beim Bestätigen fehlgeschlagen ist, wird erneut versucht (das ist die eigene Datei der App).
 *
 * Ergebnis liegt am Arbeitsbereich (settings.o2oSync) und erscheint unter „Angebot & Bestellung › Abgleich“ sowie am Vorgang.
 */
export type SyncKind = "MOCO_LEAD" | "MOCO_PROJEKT" | "MOCO_OHNE_VORGANG" | "SHAREPOINT_FEHLER" | "SHAREPOINT_OHNE_VORGANG";
export type SyncItem = { key: string; kind: SyncKind; caseId: string | null; number: string | null; label: string; detail: string; href: string; external: string | null };
export type SyncResult = { at: string; items: SyncItem[]; moco: boolean; sharepoint: boolean; retried: number; error: string | null };

export const syncKindLabel: Record<SyncKind, string> = {
  MOCO_LEAD: "Lead in Moco",
  MOCO_PROJEKT: "Projekt in Moco",
  MOCO_OHNE_VORGANG: "In Moco, hier ohne Vorgang",
  SHAREPOINT_FEHLER: "SharePoint-Ablage",
  SHAREPOINT_OHNE_VORGANG: "In SharePoint, hier ohne Vorgang",
};

type Settings = { o2oSync?: SyncResult; o2oSyncHidden?: string[] };
type Ids = { dealId?: number; projectId?: number; customerCompanyId?: number };
const de = (iso: string | null | undefined) => (iso ? iso.split("-").reverse().join(".") : "–");

export function canRunSync(actor: Actor): boolean {
  return hasRole(actor, "CEO") || hasRole(actor, "SALES_OPS") || hasRole(actor, "ADMIN");
}

async function settingsOf(workspaceId: string): Promise<Settings> {
  const ws = await db.query.workspaces.findFirst({ where: eq(schema.workspaces.id, workspaceId), columns: { settings: true } });
  return ((ws?.settings ?? {}) as Settings) ?? {};
}

/** Letztes Ergebnis ohne ausgeblendete Einträge. */
export async function lastSync(workspaceId: string): Promise<SyncResult | null> {
  const s = await settingsOf(workspaceId);
  if (!s.o2oSync) return null;
  const hidden = new Set(s.o2oSyncHidden ?? []);
  return { ...s.o2oSync, items: s.o2oSync.items.filter((i) => !hidden.has(i.key)) };
}

/** Einen Hinweis dauerhaft ausblenden (z. B. internes Moco-Projekt, das nie einen Vorgang bekommt). */
export async function hideSyncItem(actor: Actor, key: string): Promise<void> {
  if (!canRunSync(actor)) throw new ForbiddenError("Den Abgleich pflegen Geschäftsführung und Sales Operations.");
  const ws = await db.query.workspaces.findFirst({ where: eq(schema.workspaces.id, actor.workspaceId) });
  const s = (ws?.settings ?? {}) as Settings & Record<string, unknown>;
  const hidden = [...new Set([...(s.o2oSyncHidden ?? []), key.slice(0, 120)])].slice(-500);
  await db.update(schema.workspaces).set({ settings: { ...s, o2oSyncHidden: hidden }, updatedAt: new Date() }).where(eq(schema.workspaces.id, actor.workspaceId));
}

/** Von Hand anstoßen (Schaltfläche „Jetzt abgleichen“). */
export async function runSyncNow(actor: Actor): Promise<SyncResult> {
  if (!canRunSync(actor)) throw new ForbiddenError("Den Abgleich stoßen Geschäftsführung und Sales Operations an.");
  return dailyCheck(actor.workspaceId);
}

export async function dailyCheck(workspaceId: string, deps: { moco?: MocoFullClient | null; sp?: SpClient | null; now?: Date } = {}): Promise<SyncResult> {
  const now = deps.now ?? new Date();
  const items: SyncItem[] = [];
  const add = (i: Omit<SyncItem, "key"> & { key?: string }) => items.push({ ...i, key: i.key ?? `${i.kind}:${i.caseId ?? i.external ?? i.label}:${i.detail}`.slice(0, 120) });
  const cases = (await db.query.orderCases.findMany({ where: and(eq(schema.orderCases.workspaceId, workspaceId), ne(schema.orderCases.status, "ENTWURF")) })).filter((c) => c.status !== "ABGESAGT" && c.status !== "STORNIERT");
  const idsOf = (c: (typeof cases)[number]) => (((c.systems ?? {}) as { moco?: { ids?: Ids } }).moco?.ids ?? {}) as Ids;
  const label = (c: (typeof cases)[number]) => [c.role, c.personName].filter(Boolean).join(" – ") || c.number;
  let error: string | null = null;

  // --- Moco ---------------------------------------------------------------------------------------------------
  const moco = deps.moco !== undefined ? deps.moco : mocoEnabled() ? getMocoClient() : null;
  if (moco) {
    try {
      const deals = new Map((await moco.deals()).map((d) => [d.id, d]));
      const projects = new Map((await moco.projects({ includeArchived: true })).map((p) => [p.id, p]));
      const engIds = cases.map((c) => c.engagementId).filter((x): x is string => !!x);
      const engs = engIds.length ? await db.query.engagements.findMany({ where: inArray(schema.engagements.id, engIds), columns: { id: true, plannedEnd: true, status: true, orderReference: true } }) : [];
      const engOf = new Map(engs.map((e) => [e.id, e]));
      for (const c of cases) {
        const ids = idsOf(c);
        const href = `/auftragseingang/${c.id}#moco`;
        if (ids.dealId) {
          const d = deals.get(ids.dealId);
          const ext = mocoDealUrl(ids.dealId);
          if (!d) add({ kind: "MOCO_LEAD", caseId: c.id, number: c.number, label: label(c), detail: "Lead ist in Moco nicht mehr vorhanden (gelöscht?).", href, external: ext });
          else if (c.status === "ANGEBOT_VERSENDET" && d.status === "won") add({ kind: "MOCO_LEAD", caseId: c.id, number: c.number, label: label(c), detail: "In Moco als gewonnen markiert – hier fehlt die Bestellung. Bestellung hochladen.", href: "/auftragseingang", external: ext });
          else if (c.status === "ANGEBOT_VERSENDET" && (d.status === "lost" || d.status === "dropped")) add({ kind: "MOCO_LEAD", caseId: c.id, number: c.number, label: label(c), detail: `In Moco als ${d.status === "lost" ? "verloren" : "fallen gelassen"} markiert – hier noch offen. Vorgang absagen?`, href: `/auftragseingang/${c.id}#absage`, external: ext });
          else if (c.status === "BEAUFTRAGT" && d.status !== "won") add({ kind: "MOCO_LEAD", caseId: c.id, number: c.number, label: label(c), detail: `Hier beauftragt, in Moco steht der Lead auf „${d.status}“.`, href, external: ext });
        }
        if (c.status === "BEAUFTRAGT" && ids.projectId) {
          const p = projects.get(ids.projectId);
          const ext = mocoProjectUrl(ids.projectId);
          if (!p) { add({ kind: "MOCO_PROJEKT", caseId: c.id, number: c.number, label: label(c), detail: "Projekt ist in Moco nicht mehr vorhanden.", href, external: ext }); continue; }
          const e = c.engagementId ? engOf.get(c.engagementId) : null;
          const wantEnd = e?.plannedEnd ?? c.endDate;
          const diffs: string[] = [];
          if (c.startDate && p.start_date && p.start_date !== c.startDate) diffs.push(`Start in Moco ${de(p.start_date)}, hier ${de(c.startDate)}`);
          if (wantEnd && p.finish_date && p.finish_date !== wantEnd) diffs.push(`Ende in Moco ${de(p.finish_date)}, hier ${de(wantEnd)}`);
          if (ids.customerCompanyId && p.customer && p.customer.id !== ids.customerCompanyId) diffs.push(`Kunde in Moco „${p.customer.name || p.customer.id}“ – anders als bei der Anlage`);
          const po = p.custom_properties?.Bestellnummer;
          const wantPo = e?.orderReference ?? c.orderNumber;
          if (po != null && wantPo && po.trim() !== wantPo.trim()) diffs.push(`Bestellnummer in Moco „${po || "leer"}“, hier „${wantPo}“`);
          if (!p.active && e && ["AKTIV", "GEPLANT", "PAUSIERT"].includes(e.status)) diffs.push("Projekt ist in Moco archiviert, der Einsatz läuft hier noch");
          if (diffs.length) add({ kind: "MOCO_PROJEKT", caseId: c.id, number: c.number, label: label(c), detail: `${diffs.join(" · ")}. Moco wird nicht überschrieben – bitte prüfen, wo es stimmt.`, href, external: ext });
        }
      }
      // Neue Projekte in Moco, die hier keinen Vorgang und keinen Einsatz haben (R6: an der App vorbei angelegt)
      const known = new Set<number>(cases.map((c) => idsOf(c).projectId).filter((x): x is number => !!x));
      for (const e of await db.query.engagements.findMany({ where: and(eq(schema.engagements.workspaceId, workspaceId), isNotNull(schema.engagements.mocoProjectId)), columns: { mocoProjectId: true } })) if (e.mocoProjectId) known.add(Number(e.mocoProjectId));
      const since = new Date(now.getTime() - 21 * 86400000).toISOString().slice(0, 10);
      const startFrom = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10);
      for (const p of projects.values()) {
        if (known.has(p.id) || !p.active || !p.billable) continue;
        if (p.updated_at && p.updated_at.slice(0, 10) < since) continue;
        if (p.start_date && p.start_date < startFrom) continue;
        if (isInternalMocoCompany(p.customer?.name)) continue;
        add({ kind: "MOCO_OHNE_VORGANG", caseId: null, number: p.identifier, label: `${p.customer?.name ?? "?"} – ${p.name}`, detail: `Projekt ${de(p.start_date)} bis ${de(p.finish_date)} ist in Moco, hier gibt es keinen Vorgang. Bestellung hochladen oder ausblenden.`, href: "/auftragseingang", external: mocoProjectUrl(p.id), key: `MOCO_OHNE_VORGANG:${p.id}` });
      }
    } catch (err) {
      error = `Moco: ${(err as Error).message.slice(0, 200)}`;
    }
  }

  // --- SharePoint ---------------------------------------------------------------------------------------------
  let retried = 0;
  const { sharePointEnabled, defaultSpClient } = await import("@/modules/sharepoint/client");
  const sp = deps.sp !== undefined ? deps.sp : sharePointEnabled() ? await defaultSpClient().catch(() => null) : null;
  if (sp) {
    try {
      const { fileCaseDocuments } = await import("./files");
      for (const c of cases) {
        const st = ((c.systems ?? {}) as { sharepoint?: { state?: string } }).sharepoint?.state;
        if (st !== "FEHLER") continue;
        const r = await fileCaseDocuments(c.id, { client: sp });
        if (r.state === "ABGELEGT") retried++;
        else add({ kind: "SHAREPOINT_FEHLER", caseId: c.id, number: c.number, label: label(c), detail: `Ablage schlägt weiter fehl: ${r.note ?? "unbekannter Fehler"}`, href: `/auftragseingang/${c.id}`, external: null });
      }
      // Dateien, die an der App vorbei abgelegt wurden (Notfall-Schreibrecht, R6) – je Kunde mit Vorgang, laufendes Jahr
      const { folderName, KUNDE_SUB, LIB, libraryMap } = await import("@/modules/sharepoint/service");
      const libs = await libraryMap(sp);
      const listId = libs.get(LIB.KUNDEN);
      if (listId) {
        const drive = await sp.driveOf(listId);
        const accIds = [...new Set(cases.flatMap((c) => [c.partnerAccountId, c.endCustomerAccountId]).filter((x): x is string => !!x))];
        const accs = accIds.length ? await db.query.accounts.findMany({ where: inArray(schema.accounts.id, accIds), columns: { id: true, name: true } }) : [];
        const knownItems = new Set((await db.query.contractDocuments.findMany({ where: and(eq(schema.contractDocuments.workspaceId, workspaceId), isNotNull(schema.contractDocuments.spItemId)), columns: { spItemId: true } })).map((d) => d.spItemId!));
        const year = todayIso().slice(0, 4);
        const fresh = new Date(now.getTime() - 30 * 86400000).toISOString();
        for (const a of accs) {
          for (const sub of [KUNDE_SUB[1], KUNDE_SUB[2]]) {
            const files = await sp.children(drive, [folderName(a.name), sub, year]).catch(() => []);
            for (const f of files) {
              if (f.folder || knownItems.has(f.id)) continue;
              if (f.modified && f.modified < fresh) continue;
              add({ kind: "SHAREPOINT_OHNE_VORGANG", caseId: null, number: null, label: `${a.name} › ${sub}`, detail: `„${f.name}“ liegt in SharePoint, hier gibt es keinen Vorgang dazu. Über „Angebot & Bestellung“ hochladen oder ausblenden.`, href: "/auftragseingang", external: f.webUrl, key: `SHAREPOINT_OHNE_VORGANG:${f.id}` });
            }
          }
        }
      }
    } catch (err) {
      error = [error, `SharePoint: ${(err as Error).message.slice(0, 200)}`].filter(Boolean).join(" · ");
    }
  }

  const result: SyncResult = { at: now.toISOString(), items: items.slice(0, 300), moco: !!moco, sharepoint: !!sp, retried, error };
  const ws = await db.query.workspaces.findFirst({ where: eq(schema.workspaces.id, workspaceId) });
  await db.update(schema.workspaces).set({ settings: { ...((ws?.settings ?? {}) as Record<string, unknown>), o2oSync: result } }).where(eq(schema.workspaces.id, workspaceId));
  return result;
}

/** Hintergrunddienst: einmal täglich je Arbeitsbereich. */
export async function dailyCheckAll(): Promise<Record<string, number>> {
  let hinweise = 0;
  let wiederholt = 0;
  const today = todayIso();
  for (const ws of await db.query.workspaces.findMany({ columns: { id: true, settings: true } })) {
    const last = ((ws.settings ?? {}) as Settings).o2oSync?.at?.slice(0, 10);
    if (last === today) continue;
    const r = await dailyCheck(ws.id);
    hinweise += r.items.length;
    wiederholt += r.retried;
  }
  return { hinweise, wiederholt };
}
