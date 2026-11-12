import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { backofficeUserIds } from "@/modules/conversion/profile";
import { todayIso } from "@/modules/work/calendar";
import { defaultSpClient, sharePointEnabled, type SpClient, type SpColumn } from "./client";

/**
 * SharePoint-Ablage (e45): Aufbau der Site „Vertrieb und Verträge“ und Ablage der erzeugten Verträge.
 * Aufbau siehe Konzept: drei Bibliotheken (Kunden, Freelancer, Vorlagen), Spalten mit festen internen Namen,
 * je Kunde und je Freelancer ein Ordner mit festen Unterordnern. Rechte und Ansichten setzt der Besitzer der Site.
 */

export const LIB = { KUNDEN: "Kunden", FREELANCER: "Freelancer", VORLAGEN: "Vorlagen" } as const;
export const LIBRARIES = [LIB.KUNDEN, LIB.FREELANCER, LIB.VORLAGEN] as const;
export const KUNDE_SUB = ["Rahmen und Einkauf", "Angebote", "Bestellungen"] as const;
export const FREELANCER_SUB = ["Verträge", "Nachweise"] as const;
export const VORLAGEN_SUB = ["Vertrag", "Angebot Kunde"] as const;

export const COLUMNS: SpColumn[] = [
  { name: "Dokumentart", displayName: "Dokumentart", kind: "choice", choices: ["Angebot", "Bestellung", "Nachtrag", "Rahmenvertrag", "NDA", "Projekteinzelvertrag", "Nachweis", "Sonstiges"] },
  { name: "Kunde", displayName: "Kunde", kind: "text" },
  { name: "Person", displayName: "Person", kind: "text" },
  { name: "Bestellnummer", displayName: "Bestellnummer", kind: "text" },
  { name: "Angebotsnummer", displayName: "Angebotsnummer", kind: "text" },
  { name: "MocoProjekt", displayName: "Moco-Projekt", kind: "text" },
  { name: "GueltigVon", displayName: "Gültig von", kind: "date" },
  { name: "GueltigBis", displayName: "Gültig bis", kind: "date" },
  { name: "DokStatus", displayName: "Status", kind: "choice", choices: ["Entwurf", "versendet", "unterschrieben", "ersetzt"] },
];

const RUNNING = ["VORBEREITUNG", "GEPLANT", "AKTIV", "PAUSIERT", "ENDET"];

export function canManageSharePoint(actor: Actor): boolean {
  return hasRole(actor, "CEO") || actor.roles.has("ADMIN");
}

/** Ordnername nach SharePoint-Regeln (gleiche Regel wie im Einrichtungsskript): „|“ → „ - “, verbotene Zeichen → „-“. */
export function folderName(name: string): string {
  return name
    .trim()
    .replace(/\s*\|\s*/g, " - ")
    .replace(/["*:<>?/\\|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "");
}

/** Freelancer-Ordner „Nachname, Vorname“; ein Zusatz in Klammern bleibt hinten stehen. */
export function freelancerFolder(displayName: string): string {
  const n = displayName.trim();
  if (n.includes(",")) return folderName(n);
  const m = /^(.*?\S)\s+(\S+)(\s*\(.*\))?$/.exec(n);
  return folderName(m ? `${m[2]}, ${m[1]}${m[3] ?? ""}` : n);
}

const statusOf: Record<string, string> = { ENTWURF: "Entwurf", VERSENDET: "versendet", UNTERSCHRIEBEN: "unterschrieben", GEKUENDIGT: "ersetzt" };
const docTypeOf: Record<string, string> = { EINZELBEAUFTRAGUNG: "Projekteinzelvertrag", RAHMENVERTRAG: "Rahmenvertrag", BESTELLUNG: "Bestellung", NACHTRAG: "Nachtrag", NDA: "NDA" };

export type SetupStep = { what: string; created: number; existing: number };
export type SetupResult = { steps: SetupStep[]; folders: string[]; errors: string[] };

async function libraryMap(client: SpClient) {
  const libs = await client.libraries();
  return new Map(libs.map((l) => [l.name, l.id]));
}

/** Kunden und Freelancer mit laufendem Einsatz – für sie entstehen beim Einrichten die Ordner. */
async function activeNames(workspaceId: string) {
  const engs = await db.query.engagements.findMany({ where: and(eq(schema.engagements.workspaceId, workspaceId), inArray(schema.engagements.status, RUNNING)), columns: { accountId: true, freelancerId: true } });
  const [accounts, fls] = await Promise.all([
    db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(engs.map((e) => e.accountId)), "-"]), columns: { name: true } }),
    db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...new Set(engs.map((e) => e.freelancerId).filter((x): x is string => !!x)), "-"]), columns: { displayName: true, mergedIntoId: true } }),
  ]);
  return {
    kunden: [...new Set(accounts.map((a) => folderName(a.name)))].sort((a, b) => a.localeCompare(b, "de")),
    freelancer: [...new Set(fls.filter((f) => !f.mergedIntoId).map((f) => freelancerFolder(f.displayName)))].sort((a, b) => a.localeCompare(b, "de")),
  };
}

/**
 * Site einrichten bzw. ergänzen: Bibliotheken, Spalten, Ordner. Darf mehrfach laufen und legt nur an, was fehlt.
 * Ein Fehler bei einem Ordner bricht nicht ab; er steht im Ergebnis.
 */
export async function setupSite(actor: Actor, deps: { client?: SpClient } = {}): Promise<SetupResult> {
  if (!canManageSharePoint(actor)) throw new ForbiddenError("SharePoint richtet die Geschäftsführung oder die Verwaltung ein.");
  const client = deps.client ?? (await defaultSpClient());
  const res: SetupResult = { steps: [], folders: [], errors: [] };
  const libs = await libraryMap(client);
  const libStep = { what: "Bibliotheken", created: 0, existing: 0 };
  for (const name of LIBRARIES) {
    if (libs.has(name)) libStep.existing++;
    else {
      const l = await client.createLibrary(name);
      libs.set(name, l.id);
      libStep.created++;
    }
  }
  res.steps.push(libStep);
  const colStep = { what: "Spalten", created: 0, existing: 0 };
  for (const name of [LIB.KUNDEN, LIB.FREELANCER]) {
    const listId = libs.get(name)!;
    const have = new Set(await client.columns(listId));
    for (const c of COLUMNS) {
      if (have.has(c.name)) colStep.existing++;
      else {
        await client.createColumn(listId, c);
        colStep.created++;
      }
    }
  }
  res.steps.push(colStep);
  const { kunden, freelancer } = await activeNames(actor.workspaceId);
  const plan: { lib: string; path: string[] }[] = [
    ...kunden.flatMap((k) => KUNDE_SUB.map((u) => ({ lib: LIB.KUNDEN, path: [k, u] }))),
    ...freelancer.flatMap((f) => FREELANCER_SUB.map((u) => ({ lib: LIB.FREELANCER, path: [f, u] }))),
    ...VORLAGEN_SUB.map((u) => ({ lib: LIB.VORLAGEN, path: [u] })),
  ];
  const drives = new Map<string, string>();
  const folderStep = { what: "Ordner", created: 0, existing: 0 };
  for (const p of plan) {
    try {
      if (!drives.has(p.lib)) drives.set(p.lib, await client.driveOf(libs.get(p.lib)!));
      const f = await client.ensureFolder(drives.get(p.lib)!, p.path);
      if (f.created) folderStep.created++;
      else folderStep.existing++;
      if (p.path.length === 1 || p.path.at(-1) === KUNDE_SUB[0] || p.path.at(-1) === FREELANCER_SUB[0]) res.folders.push(`${p.lib}/${p.path.length > 1 ? p.path[0] : p.path.join("/")}`);
    } catch (e) {
      res.errors.push(`${p.lib}/${p.path.join("/")}: ${(e as Error).message}`);
    }
  }
  res.steps.push(folderStep);
  await recordAudit(db, actor, "sharepoint.setup", "WORKSPACE", actor.workspaceId, { schritte: res.steps, fehler: res.errors.length });
  return res;
}

export type SiteStatus = { enabled: boolean; ok: boolean; error: string | null; libraries: { name: string; present: boolean; columnsMissing: string[] }[] };

/** Stand der Site lesen (ohne etwas zu ändern). */
export async function siteStatus(actor: Actor, deps: { client?: SpClient } = {}): Promise<SiteStatus> {
  if (!canManageSharePoint(actor)) throw new ForbiddenError();
  if (!deps.client && !sharePointEnabled()) return { enabled: false, ok: false, error: null, libraries: [] };
  try {
    const client = deps.client ?? (await defaultSpClient());
    const libs = await libraryMap(client);
    const out: SiteStatus["libraries"] = [];
    for (const name of LIBRARIES) {
      const id = libs.get(name);
      const have = id && name !== LIB.VORLAGEN ? new Set(await client.columns(id)) : null;
      out.push({ name, present: !!id, columnsMissing: have ? COLUMNS.filter((c) => !have.has(c.name)).map((c) => c.displayName) : [] });
    }
    return { enabled: true, ok: true, error: null, libraries: out };
  } catch (e) {
    return { enabled: true, ok: false, error: (e as Error).message, libraries: [] };
  }
}

/**
 * Wer bekommt in SharePoint welche Rechte? Aus den Rollen im Accountmeister abgeleitet, damit der Besitzer die Namen
 * nur noch eintragen muss. Die Buchhaltung kennt der Accountmeister nicht – sie steht als Zeile ohne Namen da.
 */
export async function permissionPlan(actor: Actor) {
  if (!canManageSharePoint(actor)) throw new ForbiddenError();
  const t = todayIso();
  const [roles, users, bo] = await Promise.all([
    db.query.roleAssignments.findMany({ where: eq(schema.roleAssignments.workspaceId, actor.workspaceId), columns: { userId: true, role: true, validTo: true } }),
    db.query.users.findMany({ where: and(eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")), columns: { id: true, displayName: true, email: true } }),
    backofficeUserIds(actor.workspaceId),
  ]);
  const active = new Map(users.map((u) => [u.id, u]));
  const withRole = (r: string[]) => [...new Set(roles.filter((x) => r.includes(x.role) && (!x.validTo || x.validTo >= t)).map((x) => x.userId))].map((id) => active.get(id)).filter((u): u is NonNullable<typeof u> => !!u);
  const people = (list: { displayName: string; email: string }[]) => list.sort((a, b) => a.displayName.localeCompare(b.displayName, "de")).map((u) => ({ name: u.displayName, email: u.email }));
  const gf = withRole(["CEO"]);
  const ops = withRole(["SALES_OPS"]).filter((u) => !gf.includes(u));
  const backoffice = bo.map((id) => active.get(id)).filter((u): u is NonNullable<typeof u> => !!u && !gf.includes(u) && !ops.includes(u));
  const vertrieb = withRole(["BD", "PRINCIPAL"]).filter((u) => !gf.includes(u) && !ops.includes(u) && !backoffice.includes(u));
  return [
    { rolle: "Geschäftsführung", kunden: "Vollzugriff", freelancer: "Vollzugriff", vorlagen: "Vollzugriff", personen: people(gf) },
    { rolle: "Sales Operations", kunden: "Bearbeiten", freelancer: "Bearbeiten", vorlagen: "Bearbeiten", personen: people(ops) },
    { rolle: "Backoffice", kunden: "Bearbeiten", freelancer: "Bearbeiten", vorlagen: "Lesen", personen: people(backoffice) },
    { rolle: "Buchhaltung", kunden: "Lesen", freelancer: "Lesen", vorlagen: "–", personen: [] as { name: string; email: string }[] },
    { rolle: "Vertrieb (BD, Principals)", kunden: "Bearbeiten", freelancer: "–", vorlagen: "Lesen", personen: people(vertrieb) },
  ];
}

/**
 * Erzeugten Freelancer-Vertrag ablegen: Freelancer › Person › Verträge, mit Spalten. Gibt null zurück, wenn SharePoint
 * aus ist. Ein Fehler wirft – der Aufrufer entscheidet, ob er ihn nur meldet.
 */
export async function fileFreelancerContract(input: { documentId: string; accountName: string; freelancerName: string; fileName: string; bytes: ArrayBuffer; validFrom: string | null; validTo: string | null; status: string; reference?: string | null }, deps: { client?: SpClient } = {}): Promise<{ webUrl: string } | null> {
  if (!deps.client && !sharePointEnabled()) return null;
  const client = deps.client ?? (await defaultSpClient());
  const libs = await libraryMap(client);
  const listId = libs.get(LIB.FREELANCER);
  if (!listId) throw new Error("In SharePoint fehlt die Bibliothek „Freelancer“ – bitte unter Verwaltung › SharePoint einrichten.");
  const drive = await client.driveOf(listId);
  const folder = [freelancerFolder(input.freelancerName), FREELANCER_SUB[0]];
  const item = await client.upload(drive, folder, input.fileName, input.bytes);
  await client.setFields(drive, item.id, {
    Dokumentart: "Projekteinzelvertrag",
    Kunde: input.accountName,
    Person: input.freelancerName.replace(/\s*\(.*?\)\s*/g, " ").trim(),
    GueltigVon: input.validFrom,
    GueltigBis: input.validTo,
    Bestellnummer: input.reference ?? null,
    DokStatus: statusOf[input.status] ?? "Entwurf",
  });
  await db.update(schema.contractDocuments).set({ link: item.webUrl, spDriveId: drive, spItemId: item.id, updatedAt: new Date() }).where(eq(schema.contractDocuments.id, input.documentId));
  return { webUrl: item.webUrl };
}

/** Status oder Art einer abgelegten Unterlage in SharePoint nachführen (z. B. „versendet“, „unterschrieben“). */
export async function syncDocumentFields(documentId: string, deps: { client?: SpClient } = {}): Promise<boolean> {
  const d = await db.query.contractDocuments.findFirst({ where: eq(schema.contractDocuments.id, documentId) });
  if (!d?.spDriveId || !d.spItemId) return false;
  if (!deps.client && !sharePointEnabled()) return false;
  const client = deps.client ?? (await defaultSpClient());
  await client.setFields(d.spDriveId, d.spItemId, { DokStatus: statusOf[d.signedStatus] ?? null, Dokumentart: docTypeOf[d.docType] ?? "Sonstiges", GueltigVon: d.validFrom, GueltigBis: d.validTo });
  return true;
}
