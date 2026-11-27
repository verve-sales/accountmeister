import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ForbiddenError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { getMocoClient, mocoEnabled, mocoProjectUrl, type MocoFullClient } from "@/modules/moco/client";
import { todayIso } from "@/modules/work/calendar";
import { hourlyRate } from "./plan";
import { requireCase } from "./service";

/**
 * e70: Auftragseingang schreibt nach Moco. Aus einer bestätigten Bestellung entstehen Schritt für Schritt Firma (nur
 * verknüpfen oder ausdrücklich neu), beim Vermittler dessen Kontakt „Buchhaltung“ als Rechnungsempfänger, Lead („gewonnen“),
 * Projekt mit Bestellnummer, Leistung mit Stundensatz (Tagessatz ÷ 8) und die Person. Jeder Schritt ist wiederholbar:
 * was schon angelegt ist (gemerkte Moco-IDs), wird nicht noch einmal angelegt. Nichts wird gelöscht.
 */

export type MocoIds = { customerCompanyId?: number; brokerCompanyId?: number; contactId?: number; dealId?: number; projectId?: number; taskId?: number; contractId?: number };
export type StepResult = { key: string; title: string; state: "ERLEDIGT" | "FEHLER" | "OFFEN" | "ENTFAELLT"; detail: string };
export type MocoInput = {
  broker: boolean;
  customerName: string;
  brokerName: string | null;
  projectName: string;
  personName: string | null;
  personMocoUserId: number | null;
  leaderMocoUserId: number | null;
  startDate: string | null;
  endDate: string | null;
  dailyRate: number | null;
  days: number | null;
  orderNumber: string | null;
  note: string;
  /** Firma in Moco neu anlegen, wenn es keine gleichnamige gibt (R3: nur ausdrücklich) */
  allowCreateCustomer: boolean;
  allowCreateBroker: boolean;
};

const norm = (n: string) => n.toLocaleLowerCase("de").replace(/\(.*?\)/g, " ").replace(/\b(gmbh|ag|eg|se|kg|mbh|co|e\.?v\.?)\b/g, " ").replace(/[^a-z0-9äöüß]+/g, " ").trim();
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

async function ensureCompany(client: MocoFullClient, name: string, known: number | undefined, allowCreate: boolean): Promise<{ id: number; detail: string } | { id: null; detail: string }> {
  if (known) return { id: known, detail: "bereits verknüpft" };
  const all = await client.companies({ type: "customer" });
  const n = norm(name);
  const exact = all.filter((c) => norm(c.name) === n);
  if (exact.length === 1) return { id: exact[0]!.id, detail: `gefunden: ${exact[0]!.name}` };
  if (exact.length > 1) return { id: null, detail: `mehrere Firmen heißen „${name}“ in Moco – bitte dort zusammenführen oder am Kunden die Moco-Firma hinterlegen` };
  const first = n.split(" ")[0] ?? "";
  const similar = first.length >= 4 ? all.filter((c) => norm(c.name).split(" ").includes(first)) : [];
  if (similar.length === 1 && !allowCreate) return { id: similar[0]!.id, detail: `gefunden (ähnlicher Name): ${similar[0]!.name}` };
  if (!allowCreate) return { id: null, detail: similar.length ? `ähnliche Firmen in Moco: ${similar.slice(0, 4).map((c) => c.name).join(", ")} – „neu anlegen“ anhaken oder am Kunden die Moco-Firma hinterlegen` : `„${name}“ gibt es in Moco noch nicht – „neu anlegen“ anhaken` };
  const c = await client.createCompany({ name, type: "customer", currency: "EUR" });
  return { id: c.id, detail: `neu angelegt: ${c.name}` };
}

/** Kern: führt die Schritte gegen Moco aus. Kennt keine Datenbank – Eingaben und gemerkte IDs rein, Ergebnis raus. */
export async function writeOrderToMoco(client: MocoFullClient, input: MocoInput, ids0: MocoIds = {}): Promise<{ ids: MocoIds; steps: StepResult[]; done: boolean }> {
  const ids: MocoIds = { ...ids0 };
  const steps: StepResult[] = [];
  const push = (key: string, title: string, state: StepResult["state"], detail: string) => steps.push({ key, title, state, detail });
  const cfg = getConfig();
  let blocked = false;
  const run = async (key: string, title: string, fn: () => Promise<string | null>) => {
    if (blocked) return push(key, title, "OFFEN", "wartet auf den Schritt davor");
    try {
      const detail = await fn();
      if (detail === null) {
        blocked = true;
        return;
      }
      push(key, title, "ERLEDIGT", detail);
    } catch (e) {
      blocked = true;
      push(key, title, "FEHLER", errText(e));
    }
  };

  if (!input.startDate || !input.endDate) {
    push("project", "Projekt anlegen", "OFFEN", "Start und Ende fehlen – Moco verlangt beides");
    return { ids, steps, done: false };
  }
  if (!input.leaderMocoUserId) {
    push("project", "Projekt anlegen", "OFFEN", "Der verantwortliche BD ist keinem Moco-Nutzer zugeordnet (Projektleitung) – Moco-Import der Personen ausführen");
    return { ids, steps, done: false };
  }

  await run("customer", `Firma ${input.customerName}`, async () => {
    const r = await ensureCompany(client, input.customerName, ids.customerCompanyId, input.allowCreateCustomer);
    if (r.id === null) {
      push("customer", `Firma ${input.customerName}`, "OFFEN", r.detail);
      return null;
    }
    ids.customerCompanyId = r.id;
    return r.detail;
  });

  if (input.broker && input.brokerName) {
    await run("broker", `Vermittler ${input.brokerName}`, async () => {
      const r = await ensureCompany(client, input.brokerName!, ids.brokerCompanyId, input.allowCreateBroker);
      if (r.id === null) {
        push("broker", `Vermittler ${input.brokerName}`, "OFFEN", r.detail);
        return null;
      }
      ids.brokerCompanyId = r.id;
      return r.detail;
    });
    await run("contact", "Kontakt „Buchhaltung“ beim Vermittler", async () => {
      if (ids.contactId) return "bereits angelegt";
      const found = (await client.contacts("Buchhaltung")).find((c) => c.companyId === ids.brokerCompanyId && c.lastname.trim().toLowerCase() === "buchhaltung");
      if (found) {
        ids.contactId = found.id;
        return "gefunden";
      }
      // Muster aus Moco: Anrede neutral, Name „Buchhaltung“, Position „Buchhaltung“, Firma = Vermittler
      const c = await client.createContact({ lastname: "Buchhaltung", gender: "U", company_id: ids.brokerCompanyId!, job_position: "Buchhaltung" });
      ids.contactId = c.id;
      return "neu angelegt (neutral, Position Buchhaltung)";
    });
  }

  const hourly = hourlyRate(input.dailyRate);
  const budgetHours = input.days ? Math.round(input.days * 8) : undefined;
  await run("deal", "Lead", async () => {
    const cats = await client.dealCategories();
    const want = cfg.MOCO_OFFER_PHASE.toLowerCase();
    const cat = cats.find((c) => c.name.toLowerCase() === want) ?? cats.find((c) => c.name.toLowerCase().includes(want.replace(/^\d+\s*%\s*-\s*/, ""))) ?? [...cats].sort((a, b) => b.probability - a.probability)[0];
    const name = [input.customerName, input.projectName, input.personName].filter(Boolean).join(" – ");
    const money = input.dailyRate && input.days ? Math.round(input.dailyRate * input.days) : 0;
    if (ids.dealId) {
      await client.updateDeal(ids.dealId, { status: "won", company_id: ids.customerCompanyId!, name, ...(money ? { money } : {}) });
      return `vorhandener Lead auf „gewonnen“ gesetzt${input.broker ? " und zum Endkunden umgezogen" : ""}`;
    }
    if (!cat) throw new Error("In Moco ist keine Lead-Phase eingerichtet.");
    const d = await client.createDeal({ name, currency: "EUR", money, reminder_date: todayIso(), user_id: input.leaderMocoUserId!, deal_category_id: cat.id, company_id: ids.customerCompanyId!, info: input.note, status: "won", tags: ["Accountmeister", ...(input.broker && input.brokerName ? [input.brokerName] : [])] });
    ids.dealId = d.id;
    return `angelegt in Phase „${cat.name}“ und als gewonnen markiert`;
  });

  await run("project", "Projekt", async () => {
    if (ids.projectId) return "bereits angelegt";
    const base = {
      name: input.projectName,
      currency: "EUR",
      start_date: input.startDate!,
      finish_date: input.endDate!,
      fixed_price: false,
      retainer: false,
      leader_id: input.leaderMocoUserId!,
      customer_id: ids.customerCompanyId!,
      deal_id: ids.dealId,
      billing_variant: "task" as const,
      ...(budgetHours && hourly ? { budget: Math.round(budgetHours * hourly) } : {}),
      info: input.note,
      tags: ["Accountmeister"],
    };
    const contact = ids.contactId ? { contact_id: ids.contactId, billing_contact_id: ids.contactId } : {};
    const custom: Record<string, string> = {
      ...(input.orderNumber ? { Bestellnummer: input.orderNumber } : {}),
      ...(input.personName ? { Consultant: input.personName } : {}),
      ...(input.broker && input.brokerName ? { "Vermittler / Provisionsempfänger": input.brokerName } : {}),
    };
    // Erster Versuch mit allem; lehnt Moco Zusatzfelder oder den Rechnungsempfänger ab (422), folgt ein schmalerer Versuch –
    // das Projekt entsteht trotzdem und der Hinweis nennt, was von Hand nachzutragen ist.
    const attempts: { payload: Parameters<MocoFullClient["createProject"]>[0]; note: string }[] = [
      { payload: { ...base, ...contact, custom_properties: custom }, note: "" },
      { payload: { ...base, ...contact }, note: ` – Zusatzfelder bitte in Moco nachtragen (${Object.entries(custom).map(([k, v]) => `${k}: ${v}`).join("; ") || "keine"})` },
      { payload: base, note: " – Zusatzfelder und Rechnungsempfänger bitte in Moco nachtragen" },
    ];
    let last: unknown = null;
    for (const a of attempts) {
      try {
        const p = await client.createProject(a.payload);
        ids.projectId = p.id;
        return `angelegt${p.identifier ? ` (${p.identifier})` : ""}: ${input.startDate} bis ${input.endDate}${input.orderNumber ? `, Bestellnummer ${input.orderNumber}` : ""}${ids.contactId ? ", Rechnungsempfänger Buchhaltung des Vermittlers" : ""}${a.note}`;
      } catch (e) {
        last = e;
        if ((e as { status?: number }).status !== 422) throw e;
      }
    }
    throw last;
  });

  await run("task", "Leistung mit Stundensatz", async () => {
    if (ids.taskId) return "bereits angelegt";
    if (hourly == null) {
      push("task", "Leistung mit Stundensatz", "OFFEN", "Tagessatz fehlt am Vorgang");
      return null;
    }
    const t = await client.createProjectTask(ids.projectId!, { name: input.personName ? `${input.projectName} – ${input.personName}` : input.projectName, billable: true, hourly_rate: hourly, ...(budgetHours ? { budget: Math.round(budgetHours * hourly) } : {}) });
    ids.taskId = t.id;
    return `${hourly.toFixed(2).replace(".", ",")} €/Std. (Tagessatz ÷ 8)${budgetHours ? `, ${budgetHours} Stunden` : ""}`;
  });

  if (!blocked) {
    if (ids.contractId) push("person", "Person im Projekt", "ERLEDIGT", "bereits eingetragen");
    else if (!input.personMocoUserId) push("person", "Person im Projekt", "OFFEN", `${input.personName ?? "Die Person"} ist kein Moco-Nutzer – bitte vom Backoffice im Projekt eintragen`);
    else {
      try {
        const c = await client.createProjectContract(ids.projectId!, { user_id: input.personMocoUserId, billable: true, active: true, ...(hourly != null ? { hourly_rate: hourly } : {}) });
        ids.contractId = c.id;
        push("person", "Person im Projekt", "ERLEDIGT", `${input.personName ?? "Person"} eingetragen`);
      } catch (e) {
        push("person", "Person im Projekt", "FEHLER", errText(e));
      }
    }
  }
  return { ids, steps, done: !!ids.projectId && !!ids.taskId };
}

export function canWriteMoco(actor: Actor): boolean {
  return actor.roles.has("SALES_OPS") || hasRole(actor, "CEO") || actor.roles.has("ADMIN");
}

export function mocoWriteOn(): boolean {
  return mocoEnabled() && getConfig().MOCO_WRITE === "on";
}

type MocoState = { mode: string; steps?: unknown[]; ids?: MocoIds; results?: StepResult[]; writtenAt?: string; projectUrl?: string | null };

/** Vorgang nach Moco schreiben (Knopf „In Moco anlegen“). Wiederholbar, bis alle Schritte erledigt sind. */
export async function writeCaseToMoco(actor: Actor, caseId: string, opts: { allowCreateCustomer?: boolean; allowCreateBroker?: boolean } = {}, client?: MocoFullClient) {
  if (!canWriteMoco(actor)) throw new ForbiddenError("Nach Moco schreiben Sales Operations, Backoffice-Verwaltung und Geschäftsführung.");
  if (!client && !mocoWriteOn()) throw new TransitionError("Das Schreiben nach Moco ist nicht eingeschaltet (MOCO_WRITE=on).");
  const c = await requireCase(actor, caseId);
  if (c.status !== "BEAUFTRAGT") throw new TransitionError("Nach Moco geht ein Vorgang, sobald die Bestellung bestätigt ist.");
  if (c.isRenewal) throw new TransitionError("Bei einer Verlängerung wird das Projektende am Einsatz fortgeschrieben – ein neues Projekt entsteht nicht.");
  const broker = c.channel === "VERMITTLER";
  const customerAccId = broker ? c.endCustomerAccountId : c.partnerAccountId;
  if (!customerAccId) throw new ValidationError("Der Endkunde fehlt noch – ohne Endkunde wird in Moco nichts angelegt.");
  const [customer, partner, opp, eng] = await Promise.all([
    db.query.accounts.findFirst({ where: eq(schema.accounts.id, customerAccId) }),
    c.partnerAccountId ? db.query.accounts.findFirst({ where: eq(schema.accounts.id, c.partnerAccountId) }) : null,
    c.opportunityId ? db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, c.opportunityId) }) : null,
    c.engagementId ? db.query.engagements.findFirst({ where: eq(schema.engagements.id, c.engagementId) }) : null,
  ]);
  if (!customer) throw new ValidationError("Kunde nicht gefunden.");
  const leaderId = eng?.bdUserId ?? opp?.ownerUserId ?? customer.responsibleBdUserId;
  const leader = leaderId ? await db.query.users.findFirst({ where: eq(schema.users.id, leaderId), columns: { mocoUserId: true } }) : null;
  const personMoco = c.internalUserId
    ? (await db.query.users.findFirst({ where: eq(schema.users.id, c.internalUserId), columns: { mocoUserId: true } }))?.mocoUserId ?? null
    : c.freelancerId
      ? (await db.query.freelancers.findFirst({ where: eq(schema.freelancers.id, c.freelancerId), columns: { mocoUserId: true } }))?.mocoUserId ?? null
      : null;
  const prev = ((c.systems ?? {}) as { moco?: MocoState }).moco ?? { mode: "PROBELAUF" };
  const ids0: MocoIds = { ...(prev.ids ?? {}), customerCompanyId: prev.ids?.customerCompanyId ?? customer.mocoCompanyId ?? undefined, brokerCompanyId: prev.ids?.brokerCompanyId ?? (broker ? partner?.mocoCompanyId ?? undefined : undefined), dealId: prev.ids?.dealId ?? opp?.mocoDealId ?? undefined, projectId: prev.ids?.projectId ?? eng?.mocoProjectId ?? undefined };
  const r = await writeOrderToMoco(client ?? getMocoClient(), {
    broker,
    customerName: customer.name,
    brokerName: broker ? partner?.name ?? null : null,
    projectName: c.role ?? opp?.title ?? "Projekt",
    personName: c.personName,
    personMocoUserId: personMoco,
    leaderMocoUserId: leader?.mocoUserId ?? null,
    startDate: c.startDate,
    endDate: c.endDate,
    dailyRate: c.dailyRate != null ? Number(c.dailyRate) : null,
    days: c.days,
    orderNumber: c.orderNumber,
    note: `Accountmeister ${c.number}${c.brokerRef ? ` · Referenz ${c.brokerRef}` : ""}`,
    allowCreateCustomer: !!opts.allowCreateCustomer,
    allowCreateBroker: !!opts.allowCreateBroker,
  }, ids0);
  // gemerkte IDs zurück in den Accountmeister: Firma am Kunden, Lead und Projekt an Chance und Einsatz
  if (r.ids.customerCompanyId && !customer.mocoCompanyId) await db.update(schema.accounts).set({ mocoCompanyId: r.ids.customerCompanyId }).where(eq(schema.accounts.id, customer.id));
  if (broker && partner && r.ids.brokerCompanyId && !partner.mocoCompanyId) await db.update(schema.accounts).set({ mocoCompanyId: r.ids.brokerCompanyId }).where(eq(schema.accounts.id, partner.id));
  if (opp && (r.ids.dealId || r.ids.projectId)) await db.update(schema.opportunities).set({ mocoDealId: r.ids.dealId ?? opp.mocoDealId, mocoProjectId: r.ids.projectId ?? opp.mocoProjectId, updatedAt: new Date() }).where(eq(schema.opportunities.id, opp.id));
  if (eng && r.ids.projectId) await db.update(schema.engagements).set({ mocoProjectId: r.ids.projectId, mocoContractId: r.ids.contractId ?? eng.mocoContractId, updatedAt: new Date() }).where(eq(schema.engagements.id, eng.id));
  const moco: MocoState = { ...prev, mode: r.done ? "GESCHRIEBEN" : "TEILWEISE", ids: r.ids, results: r.steps, writtenAt: new Date().toISOString(), projectUrl: r.ids.projectId ? mocoProjectUrl(r.ids.projectId) : null };
  await db.update(schema.orderCases).set({ systems: { ...((c.systems ?? {}) as Record<string, unknown>), moco }, updatedAt: new Date() }).where(and(eq(schema.orderCases.id, c.id), eq(schema.orderCases.workspaceId, actor.workspaceId)));
  await recordAudit(db, actor, "order_case.moco_written", "ORDER_CASE", c.id, { fertig: r.done, ids: r.ids, schritte: r.steps.map((s) => `${s.key}:${s.state}`) });
  return r;
}

/**
 * Probelauf (Verwaltung): legt einen klar benannten Testkunden mit Vermittler, Kontakt „Buchhaltung“, Lead, Projekt,
 * Leistung und – wenn möglich – der eigenen Person an. Danach in Moco prüfen und Testkunden archivieren.
 */
export async function mocoProbeRun(actor: Actor, client?: MocoFullClient) {
  if (!(hasRole(actor, "CEO") || actor.roles.has("ADMIN"))) throw new ForbiddenError("Den Moco-Probelauf startet die Geschäftsführung oder die Verwaltung.");
  if (!client && !mocoEnabled()) throw new TransitionError("Die Moco-Anbindung ist nicht eingeschaltet.");
  const me = await db.query.users.findFirst({ where: eq(schema.users.id, actor.userId), columns: { mocoUserId: true, displayName: true } });
  const stamp = todayIso();
  const start = stamp;
  const end = new Date(Date.parse(`${stamp}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
  const r = await writeOrderToMoco(client ?? getMocoClient(), {
    broker: true,
    customerName: `ZZ Test Accountmeister Endkunde ${stamp}`,
    brokerName: `ZZ Test Accountmeister Vermittler ${stamp}`,
    projectName: "Probelauf Projektanlage",
    personName: me?.displayName ?? null,
    personMocoUserId: me?.mocoUserId ?? null,
    leaderMocoUserId: me?.mocoUserId ?? null,
    startDate: start,
    endDate: end,
    dailyRate: 985,
    days: 10,
    orderNumber: "TEST-4500000001",
    note: "Probelauf des Accountmeisters – bitte prüfen und danach archivieren.",
    allowCreateCustomer: true,
    allowCreateBroker: true,
  });
  await recordAudit(db, actor, "moco.probe_run", "WORKSPACE", actor.workspaceId, { fertig: r.done, ids: r.ids, schritte: r.steps.map((s) => `${s.key}:${s.state}`) });
  return { ...r, projectUrl: r.ids.projectId ? mocoProjectUrl(r.ids.projectId) : null };
}
