import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { requireEditableSetup } from "@/modules/setups/service";
import { requireEngagement, isSalesOps, type EngagementRow } from "./authz";

/**
 * Verlängerungs-Ansprechpartner (e37): Über wen beim Kunden läuft die Verlängerung fachlich, über wen Bestellung/Vertrag,
 * und wer bei Verve spricht an (Sales Operations, BD, Berater:in selbst). Vorgabe am Setup, je Einsatz überschreibbar
 * (leer = Vorgabe des Setups). Pflegen dürfen BD-Kontext, Sales Operations und die Betreuung des Einsatzes.
 */

export const approachValues = ["SALES_OPS", "BD", "BERATER"] as const;
export type Approach = (typeof approachValues)[number];
export const approachLabel: Record<string, string> = { SALES_OPS: "Sales Operations", BD: "BD", BERATER: "Berater:in selbst" };

export type ContactPerson = { id: string; name: string; email: string | null; phone: string | null; role: string | null };
export type RenewalContacts = {
  renewal: ContactPerson | null;
  order: ContactPerson | null;
  approach: Approach | null;
  /** woher die Angaben stammen: am Einsatz gesetzt, Vorgabe des Setups oder nichts hinterlegt */
  source: "EINSATZ" | "SETUP" | null;
};

type SetupDefaults = { id: string; renewalContactPersonId: string | null; orderContactPersonId: string | null; renewalApproach: string | null };

/** Wirksame Angaben für mehrere Einsätze (Einsatz vor Setup-Vorgabe, je Feld). */
export async function loadRenewalContacts(rows: Pick<EngagementRow, "id" | "setupId" | "renewalContactPersonId" | "orderContactPersonId" | "renewalApproach">[]): Promise<Map<string, RenewalContacts>> {
  const out = new Map<string, RenewalContacts>();
  if (!rows.length) return out;
  const setups: SetupDefaults[] = await db.query.projectSetups.findMany({ where: inArray(schema.projectSetups.id, [...new Set(rows.map((r) => r.setupId))]), columns: { id: true, renewalContactPersonId: true, orderContactPersonId: true, renewalApproach: true } });
  const sm = new Map(setups.map((s) => [s.id, s]));
  const pids = new Set<string>();
  for (const r of rows) {
    const s = sm.get(r.setupId);
    for (const x of [r.renewalContactPersonId, r.orderContactPersonId, s?.renewalContactPersonId, s?.orderContactPersonId]) if (x) pids.add(x);
  }
  const persons = pids.size ? await db.query.persons.findMany({ where: inArray(schema.persons.id, [...pids]), columns: { id: true, displayName: true, email: true, phone: true } }) : [];
  const fns = pids.size ? await db.query.personFunctions.findMany({ where: inArray(schema.personFunctions.personId, [...pids]), columns: { personId: true, functionTitle: true } }) : [];
  const pm = new Map(persons.map((p) => [p.id, { id: p.id, name: p.displayName, email: p.email, phone: p.phone, role: fns.find((f) => f.personId === p.id)?.functionTitle ?? null } satisfies ContactPerson]));
  for (const r of rows) {
    const s = sm.get(r.setupId);
    const own = !!(r.renewalContactPersonId || r.orderContactPersonId || r.renewalApproach);
    const fromSetup = !!(s && (s.renewalContactPersonId || s.orderContactPersonId || s.renewalApproach));
    const ren = r.renewalContactPersonId ?? s?.renewalContactPersonId ?? null;
    const ord = r.orderContactPersonId ?? s?.orderContactPersonId ?? null;
    const appr = (r.renewalApproach ?? s?.renewalApproach ?? null) as Approach | null;
    out.set(r.id, { renewal: ren ? pm.get(ren) ?? null : null, order: ord ? pm.get(ord) ?? null : null, approach: appr, source: own ? "EINSATZ" : fromSetup ? "SETUP" : null });
  }
  return out;
}

const contactsInput = z.object({
  renewalContactPersonId: z.string().trim().max(100).optional().default(""),
  orderContactPersonId: z.string().trim().max(100).optional().default(""),
  renewalApproach: z.union([z.enum(approachValues), z.literal("")]).optional().default(""),
  /** zusätzlich als Vorgabe für alle Einsätze des Setups speichern */
  asSetupDefault: z.union([z.literal("1"), z.literal("on"), z.literal(""), z.boolean()]).optional(),
});

async function assertPersonsOfAccount(accountId: string, ids: string[]) {
  const want = ids.filter(Boolean);
  if (!want.length) return;
  const rows = await db.query.persons.findMany({ where: and(inArray(schema.persons.id, want), eq(schema.persons.accountId, accountId)), columns: { id: true } });
  if (rows.length !== new Set(want).size) throw new ValidationError("Ansprechpartner müssen Personen dieses Kunden sein.");
}

/** Am Einsatz setzen (leer = Vorgabe des Setups verwenden). Optional gleichzeitig als Setup-Vorgabe. */
export async function setEngagementContacts(actor: Actor, engagementId: string, raw: unknown) {
  const p = contactsInput.safeParse(raw);
  if (!p.success) throw new ValidationError("Angaben zur Verlängerung ungültig.");
  const a = await requireEngagement(actor, engagementId);
  if (!a.manage && !a.care) throw new ForbiddenError("Die Ansprechpartner pflegen BD, Sales Operations oder die Betreuung des Einsatzes.");
  const i = p.data;
  await assertPersonsOfAccount(a.engagement.accountId, [i.renewalContactPersonId, i.orderContactPersonId]);
  const vals = { renewalContactPersonId: i.renewalContactPersonId || null, orderContactPersonId: i.orderContactPersonId || null, renewalApproach: i.renewalApproach || null };
  const asDefault = i.asSetupDefault === true || i.asSetupDefault === "1" || i.asSetupDefault === "on";
  await db.transaction(async (tx) => {
    if (asDefault) {
      if (!a.manage) throw new ForbiddenError("Die Vorgabe am Setup setzen BD, Principal, Sales Operations oder CEO.");
      await tx.update(schema.projectSetups).set({ ...vals, updatedAt: new Date() }).where(eq(schema.projectSetups.id, a.engagement.setupId));
      // Am Einsatz nichts Eigenes mehr – er folgt der Vorgabe
      await tx.update(schema.engagements).set({ renewalContactPersonId: null, orderContactPersonId: null, renewalApproach: null, updatedAt: new Date() }).where(eq(schema.engagements.id, engagementId));
      await recordAudit(tx, actor, "setup.renewal_contacts", "SETUP", a.engagement.setupId, { ...vals, ueber: "Einsatz" });
    } else {
      await tx.update(schema.engagements).set({ ...vals, updatedAt: new Date() }).where(eq(schema.engagements.id, engagementId));
    }
    await recordAudit(tx, actor, "engagement.renewal_contacts", "ENGAGEMENT", engagementId, { ...vals, vorgabe: asDefault });
  });
  return vals;
}

/** Vorgabe am Setup. Dürfen: wer das Setup bearbeiten darf, Sales Operations, CEO. */
export async function setSetupContacts(actor: Actor, setupId: string, raw: unknown) {
  const p = contactsInput.safeParse(raw);
  if (!p.success) throw new ValidationError("Angaben zur Verlängerung ungültig.");
  const setup = await db.query.projectSetups.findFirst({ where: and(eq(schema.projectSetups.id, setupId), eq(schema.projectSetups.workspaceId, actor.workspaceId)) });
  if (!setup) throw new NotFoundError("Setup");
  if (!isSalesOps(actor) && !hasRole(actor, "CEO")) await requireEditableSetup(actor, setupId);
  const i = p.data;
  await assertPersonsOfAccount(setup.accountId, [i.renewalContactPersonId, i.orderContactPersonId]);
  const vals = { renewalContactPersonId: i.renewalContactPersonId || null, orderContactPersonId: i.orderContactPersonId || null, renewalApproach: i.renewalApproach || null };
  await db.update(schema.projectSetups).set({ ...vals, updatedAt: new Date() }).where(eq(schema.projectSetups.id, setupId));
  await recordAudit(db, actor, "setup.renewal_contacts", "SETUP", setupId, vals);
  return vals;
}
