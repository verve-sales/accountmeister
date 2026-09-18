/**
 * Synthetische Seed-Daten (Briefing Kap. 19). ALLE Angaben sind fiktiv und als Demo gekennzeichnet.
 * Kein Bezug zu echten Kunden oder Personen.
 *
 * Aufruf: npm run db:seed   (idempotent: vorhandene Demo-Daten werden erkannt und nicht doppelt angelegt)
 */
import { eq } from "drizzle-orm";
import type { Db } from "./client";
import * as schema from "./schema";
import { ARTIFACT_TEMPLATES, TEMPLATE_REGISTRY_VERSION } from "@/modules/artifacts/templates";

/** Registriert alle Artefaktvorlagen (idempotent; aktualisiert bei neuer Registerversion). */
export async function syncArtifactTemplates(db: Db): Promise<void> {
  for (const t of ARTIFACT_TEMPLATES) {
    await db
      .insert(schema.artifactTemplates)
      .values({ ...t, viewPath: t.viewPath ?? null, sections: t.sections, registryVersion: TEMPLATE_REGISTRY_VERSION })
      .onConflictDoUpdate({
        target: schema.artifactTemplates.code,
        set: { name: t.name, responsible: t.responsible, trigger: t.trigger, scopeType: t.scopeType, implementation: t.implementation, viewPath: t.viewPath ?? null, qualityCriterion: t.qualityCriterion, externalVariantAllowed: t.externalVariantAllowed, sections: t.sections, registryVersion: TEMPLATE_REGISTRY_VERSION, isActive: true, updatedAt: new Date() },
      });
  }
}

export const DEMO_WORKSPACE_NAME = "Verve (Pilot, fiktive Daten)";

export const DEMO_USERS = {
  nina: { email: "nina.demo@verve.example", displayName: "Nina Demo (Anker)" },
  david: { email: "david.demo@verve.example", displayName: "David Demo (BD)" },
  petra: { email: "petra.demo@verve.example", displayName: "Petra Demo (Principal)" },
  clemens: { email: "clemens.demo@verve.example", displayName: "Clemens Demo (CEO)" },
  admin: { email: "admin.demo@verve.example", displayName: "Admin Demo (Betrieb)" },
  lars: { email: "lars.demo@verve.example", displayName: "Lars Demo (BD, anderer Kunde)" },
} as const;

export type SeedResult = {
  workspaceId: string;
  users: Record<keyof typeof DEMO_USERS, string>;
  accountId: string;
  otherAccountId: string;
  setupId: string;
  signalId: string;
  privateSourceId: string;
};

export async function seed(db: Db): Promise<SeedResult> {
  await syncArtifactTemplates(db);
  const existing = await db.query.workspaces.findFirst({ where: eq(schema.workspaces.name, DEMO_WORKSPACE_NAME) });
  if (existing) {
    return loadExisting(db, existing.id);
  }

  return db.transaction(async (tx) => {
    const [ws] = await tx.insert(schema.workspaces).values({ name: DEMO_WORKSPACE_NAME }).returning();
    if (!ws) throw new Error("Workspace");

    const users = {} as Record<keyof typeof DEMO_USERS, string>;
    for (const key of Object.keys(DEMO_USERS) as (keyof typeof DEMO_USERS)[]) {
      const u = DEMO_USERS[key];
      const [row] = await tx.insert(schema.users).values({ workspaceId: ws.id, email: u.email, displayName: u.displayName }).returning();
      if (!row) throw new Error("User");
      users[key] = row.id;
    }

    // Arbeitsraum-weite Rollen
    await tx.insert(schema.roleAssignments).values([
      { workspaceId: ws.id, userId: users.nina, role: "ANKER" },
      { workspaceId: ws.id, userId: users.david, role: "BD" },
      { workspaceId: ws.id, userId: users.lars, role: "BD" },
      { workspaceId: ws.id, userId: users.petra, role: "PRINCIPAL" },
      { workspaceId: ws.id, userId: users.clemens, role: "CEO" },
      { workspaceId: ws.id, userId: users.admin, role: "ADMIN" },
    ]);

    // Kunde „Beispielkonzern“ (fiktiv), David ist zuständiger BD
    const [account] = await tx
      .insert(schema.accounts)
      .values({ workspaceId: ws.id, name: "Beispielkonzern AG (fiktiv)", orgType: "KONZERN", responsibleBdUserId: users.david, isDemo: true, createdBy: users.david })
      .returning();
    if (!account) throw new Error("Account");
    await tx.insert(schema.roleAssignments).values({ workspaceId: ws.id, userId: users.david, role: "BD", scope: "ACCOUNT", accountId: account.id });

    // Zweiter Kunde, den Lars betreut – Nina und David haben hier nichts zu suchen (Zugriffstests)
    const [other] = await tx
      .insert(schema.accounts)
      .values({ workspaceId: ws.id, name: "Musterwerke GmbH (fiktiv)", orgType: "EINZELUNTERNEHMEN", responsibleBdUserId: users.lars, isDemo: true, createdBy: users.lars })
      .returning();
    if (!other) throw new Error("Other account");
    await tx.insert(schema.roleAssignments).values({ workspaceId: ws.id, userId: users.lars, role: "BD", scope: "ACCOUNT", accountId: other.id });

    const [plattform] = await tx.insert(schema.orgUnits).values({ accountId: account.id, name: "Plattformteam" }).returning();
    const [migration] = await tx.insert(schema.orgUnits).values({ accountId: account.id, name: "Migrationsteam" }).returning();

    // Setup „Plattformteam“: Nina trägt Kontext bei (keine Ansprache), David ist BD
    const [setup] = await tx
      .insert(schema.projectSetups)
      .values({
        workspaceId: ws.id,
        accountId: account.id,
        name: "Plattformteam",
        contextNote: "Verve unterstützt das Plattformteam mit zwei Einsätzen (Plattform-Engineering, Testautomatisierung). Nächste Phase: Migration auf die neue Plattform.",
        status: "AKTIV",
        visibility: "MITGLIEDER",
        bdUserId: users.david,
        createdBy: users.nina,
      })
      .returning();
    if (!setup) throw new Error("Setup");
    await tx.insert(schema.setupMemberships).values([
      { setupId: setup.id, userId: users.nina, contribution: "ANKER_KONTEXT", contributionNote: "Bringt Projektkontext ein und beantwortet fachliche Rückfragen. Keine Ansprache neuer Personen vereinbart.", canEdit: true },
      { setupId: setup.id, userId: users.david, contribution: "BD_ZUSTAENDIG", contributionNote: "Operativ zuständiger BD.", canEdit: true },
    ]);

    // Bestehendes Geschäft als bestätigte Aussagen mit Quelle (Demo-Auftrag)
    const [orderSource] = await tx
      .insert(schema.sources)
      .values({
        workspaceId: ws.id,
        setupId: setup.id,
        type: "PROTOKOLL",
        title: "Demo-Bestellung Einsätze Plattformteam (fiktiv)",
        body: "Fiktive Bestellung: Einsatz A (Plattform-Engineering) bis 2027-03-31, Einsatz B (Testautomatisierung) bis 2026-12-31. Bestellweg: Einkauf Konzern.",
        origin: "manuell erfasst (Demo)",
        sourceTime: new Date("2026-06-01T09:00:00Z"),
        ownerUserId: users.david,
        accessClass: "ACCOUNT_TEAM",
      })
      .returning();
    if (!orderSource) throw new Error("Source");
    for (const content of ["Einsatz A (Plattform-Engineering) ist bis 31.03.2027 beauftragt.", "Einsatz B (Testautomatisierung) ist bis 31.12.2026 beauftragt."]) {
      const [a] = await tx
        .insert(schema.assertions)
        .values({ workspaceId: ws.id, setupId: setup.id, subjectType: "ASSIGNMENT", content, epistemicStatus: "SACHVERHALT_BESTAETIGT", confirmedBy: users.david, confirmedAt: new Date("2026-06-02T08:00:00Z"), createdBy: users.david })
        .returning();
      if (a) await tx.insert(schema.assertionEvidence).values({ assertionId: a.id, sourceId: orderSource.id, excerpt: content });
    }

    // Personen: Frau Keller (bekannt, Beziehung im Austausch mit David), Frau Brandt (nur Funktion bekannt)
    const [keller] = await tx.insert(schema.persons).values({ workspaceId: ws.id, accountId: account.id, displayName: "Frau Keller (fiktiv)", email: "keller@beispielkonzern.example", createdBy: users.david }).returning();
    const [brandt] = await tx.insert(schema.persons).values({ workspaceId: ws.id, accountId: account.id, displayName: "Frau Brandt (fiktiv)", createdBy: users.david }).returning();
    if (!keller || !brandt) throw new Error("Persons");
    await tx.insert(schema.personFunctions).values([
      { personId: keller.id, orgUnitId: plattform?.id ?? null, functionTitle: "Teamleitung Plattformteam", knownResponsibility: "Ansprechpartnerin für die bestehenden Verve-Einsätze" },
      { personId: brandt.id, orgUnitId: migration?.id ?? null, functionTitle: "Koordination Migrationsteam (vermutet)", knownResponsibility: "Zuständigkeit noch nicht bestätigt" },
    ]);
    await tx.insert(schema.relationships).values([
      { personId: keller.id, holderUserId: users.david, setupId: setup.id, state: "IM_AUSTAUSCH", contextNote: "Regelmäßiger Austausch zu den laufenden Einsätzen (Demo).", evidenceSourceId: orderSource.id, createdBy: users.david },
      { personId: brandt.id, holderUserId: users.david, setupId: setup.id, state: "NAME_FUNKTION_BEKANNT", contextNote: "Name aus Weekly-Notiz; kein persönlicher Kontakt.", createdBy: users.david },
    ]);

    // Ninas Beobachtung aus dem Weekly → Hinweis (NEU), Quelle mit Setup-Zugriff
    const [obsSource] = await tx
      .insert(schema.sources)
      .values({
        workspaceId: ws.id,
        setupId: setup.id,
        type: "NOTIZ",
        title: "Weekly-Notiz Nina (Demo)",
        body: "Im Migrationsteam wird über zusätzlichen Testkoordinationsaufwand in der nächsten Phase gesprochen. Unklar, ob externe Unterstützung vorgesehen ist.",
        origin: "Weekly Anker/BD",
        sourceTime: new Date("2026-09-14T10:00:00Z"),
        ownerUserId: users.nina,
        accessClass: "SETUP",
      })
      .returning();
    if (!obsSource) throw new Error("obsSource");
    const [signal] = await tx
      .insert(schema.signals)
      .values({
        workspaceId: ws.id,
        setupId: setup.id,
        observation: "Im Migrationsteam wird über zusätzlichen Testkoordinationsaufwand in der nächsten Phase gesprochen.",
        relevanceHypothesis: "Möglicherweise entsteht Bedarf an externer Testkoordination – bisher nur mehr Aufwand bekannt, keine externe Unterstützung vorgesehen.",
        usageLimit: "Nicht als ‚Bedarf‘ gegenüber dem Kunden formulieren; Nina nicht als Quelle nennen.",
        status: "NEU",
        sourceId: obsSource.id,
        createdBy: users.nina,
      })
      .returning();
    if (!signal) throw new Error("Signal");

    // Eine persönliche Quelle von David (nur er darf sie sehen) – für Zugriffstests
    const [privateSource] = await tx
      .insert(schema.sources)
      .values({
        workspaceId: ws.id,
        setupId: setup.id,
        type: "EMAIL",
        title: "Persönliche Demo-Mail an David (fiktiv)",
        body: "Fiktiver Mailtext: Frau Keller fragt, ob Verve für die nächste Phase Kapazität hätte. Nur für den Quelleninhaber sichtbar.",
        origin: "Demo-Fixture (kein echter Import)",
        externalKey: "demo-mail-0001",
        sourceTime: new Date("2026-09-15T14:30:00Z"),
        ownerUserId: users.david,
        accessClass: "PERSOENLICH",
      })
      .returning();
    if (!privateSource) throw new Error("privateSource");

    await tx.insert(schema.auditEvents).values({ workspaceId: ws.id, actorUserId: null, action: "seed.applied", objectType: "WORKSPACE", objectId: ws.id, changes: { hinweis: "fiktive Demo-Daten" } });

    return { workspaceId: ws.id, users, accountId: account.id, otherAccountId: other.id, setupId: setup.id, signalId: signal.id, privateSourceId: privateSource.id };
  });
}

async function loadExisting(db: Db, workspaceId: string): Promise<SeedResult> {
  const users = await db.query.users.findMany({ where: eq(schema.users.workspaceId, workspaceId) });
  const byEmail = new Map(users.map((u) => [u.email, u.id]));
  const ids = {} as Record<keyof typeof DEMO_USERS, string>;
  for (const key of Object.keys(DEMO_USERS) as (keyof typeof DEMO_USERS)[]) ids[key] = byEmail.get(DEMO_USERS[key].email) ?? "";
  const accounts = await db.query.accounts.findMany({ where: eq(schema.accounts.workspaceId, workspaceId) });
  const account = accounts.find((a) => a.name.startsWith("Beispielkonzern"));
  const other = accounts.find((a) => a.name.startsWith("Musterwerke"));
  const setup = await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.name, "Plattformteam") });
  const signal = setup ? await db.query.signals.findFirst({ where: eq(schema.signals.setupId, setup.id) }) : undefined;
  const priv = await db.query.sources.findFirst({ where: eq(schema.sources.externalKey, "demo-mail-0001") });
  return { workspaceId, users: ids, accountId: account?.id ?? "", otherAccountId: other?.id ?? "", setupId: setup?.id ?? "", signalId: signal?.id ?? "", privateSourceId: priv?.id ?? "" };
}
