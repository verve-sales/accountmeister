/**
 * Datenbankschema der Verve Sales-Arbeitsumgebung (Etappe 0/1).
 *
 * Logisches Modell siehe Briefing Kap. 15 und docs/implementierungsuebersicht.md.
 * Konventionen (Kap. 15.1): stabile IDs, Erstellungs-/Änderungszeitpunkt, Ersteller,
 * Versionsnummer (optimistische Sperre), Organisationsbezug (workspace_id).
 * Fälligkeiten sind reine Datumswerte (date), Zeitpunkte sind timestamptz.
 */
import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  integer,
  boolean,
  date,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums (fachliche Zustände, Briefing Kap. 9.2 / 15.3 / 16.2)
// ---------------------------------------------------------------------------

export const roleEnum = pgEnum("role", ["ANKER", "BD", "PRINCIPAL", "CEO", "ADMIN"]);
export const roleScopeEnum = pgEnum("role_scope", ["WORKSPACE", "ACCOUNT"]);
export const userStatusEnum = pgEnum("user_status", ["ACTIVE", "INACTIVE"]);

export const accountStatusEnum = pgEnum("account_status", ["ACTIVE", "DORMANT", "ARCHIVED"]);
export const orgTypeEnum = pgEnum("org_type", ["KONZERN", "TOCHTERGESELLSCHAFT", "EINZELUNTERNEHMEN", "OEFFENTLICH", "SONSTIGE"]);

export const setupStatusEnum = pgEnum("setup_status", ["ENTWURF", "AKTIV", "RUHEND", "ARCHIVIERT"]);
export const setupVisibilityEnum = pgEnum("setup_visibility", ["MITGLIEDER", "ACCOUNT_TEAM", "WORKSPACE"]);
export const membershipContributionEnum = pgEnum("membership_contribution", [
  "ANKER_KONTEXT", // trägt Projektkontext bei, keine Ansprache vereinbart
  "ANKER_RUECKFRAGEN", // stellt fachliche Rückfragen im Projekt
  "ANKER_EINFUEHRUNG", // ist bereit, passende Vorstellungen zu vermitteln
  "BD_ZUSTAENDIG", // operativ zuständiger BD
  "BEOBACHTER", // lesend beteiligt (z. B. Principal-Sparring)
]);

export const relationshipStateEnum = pgEnum("relationship_state", [
  "NAME_FUNKTION_BEKANNT",
  "VORSTELLUNG_ANGEFRAGT",
  "VORGESTELLT",
  "IM_AUSTAUSCH",
  "KONKRETE_ZUSAMMENARBEIT",
  "NICHT_AKTIV",
]);

export const sourceTypeEnum = pgEnum("source_type", ["NOTIZ", "PROTOKOLL", "EMAIL", "TERMIN", "OEFFENTLICH"]);
export const accessClassEnum = pgEnum("access_class", [
  "PERSOENLICH", // nur Quelleninhaber
  "SETUP", // zugeordnete Setup-Beteiligte
  "ACCOUNT_TEAM", // zuständiger BD, Principal, Setup-Beteiligte
  "WORKSPACE", // alle aktiven Nutzer des Arbeitsraums
]);

export const epistemicStatusEnum = pgEnum("epistemic_status", [
  "UNGEPRUEFT_EXTRAHIERT",
  "AUSSAGE_WIEDERGEGEBEN",
  "SACHVERHALT_BESTAETIGT",
  "HYPOTHESE",
  "WIDERSPRUECHLICH",
  "UEBERHOLT",
]);

export const signalStatusEnum = pgEnum("signal_status", [
  "NEU",
  "PRUEFUNG_UEBERNOMMEN",
  "IN_KLAERUNG",
  "MIT_BEDARF_VERKNUEPFT",
  "ZURUECKGESTELLT",
  "BEENDET",
]);

export const actionStatusEnum = pgEnum("action_status", [
  "VORGESCHLAGEN",
  "ANGENOMMEN",
  "IN_ARBEIT",
  "BLOCKIERT",
  "ERLEDIGT",
  "VERWORFEN",
]);

export const handoverStatusEnum = pgEnum("handover_status", ["ENTWURF", "ANGEFRAGT", "ANGENOMMEN", "ZURUECKGEGEBEN", "ABGESCHLOSSEN"]);
export const handoverSubjectEnum = pgEnum("handover_subject", ["SIGNAL", "SETUP", "AKTION"]);

// ---------------------------------------------------------------------------
// Gemeinsame Spalten
// ---------------------------------------------------------------------------

const id = () => text("id").primaryKey().default(sql`gen_random_uuid()::text`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const version = () => integer("version").notNull().default(1);

// ---------------------------------------------------------------------------
// Identity / Access
// ---------------------------------------------------------------------------

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  policyVersion: text("policy_version").notNull().default("pilot-0"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    status: userStatusEnum("status").notNull().default("ACTIVE"),
    timezone: text("timezone").notNull().default("Europe/Berlin"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.workspaceId, t.email)],
);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: roleEnum("role").notNull(),
    scope: roleScopeEnum("scope").notNull().default("WORKSPACE"),
    accountId: text("account_id").references((): import("drizzle-orm/pg-core").AnyPgColumn => accounts.id),
    validFrom: date("valid_from").notNull().defaultNow(),
    validTo: date("valid_to"),
    createdAt: createdAt(),
  },
  (t) => [index("role_assignments_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Accounts / Setups
// ---------------------------------------------------------------------------

export const accounts = pgTable("accounts", {
  id: id(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  orgType: orgTypeEnum("org_type").notNull().default("SONSTIGE"),
  parentAccountId: text("parent_account_id").references((): import("drizzle-orm/pg-core").AnyPgColumn => accounts.id),
  status: accountStatusEnum("status").notNull().default("ACTIVE"),
  responsibleBdUserId: text("responsible_bd_user_id").references(() => users.id),
  isDemo: boolean("is_demo").notNull().default(false),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const orgUnits = pgTable("org_units", {
  id: id(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  parentOrgUnitId: text("parent_org_unit_id").references((): import("drizzle-orm/pg-core").AnyPgColumn => orgUnits.id),
  name: text("name").notNull(),
  validFrom: date("valid_from"),
  validTo: date("valid_to"),
  createdAt: createdAt(),
});

export const projectSetups = pgTable(
  "project_setups",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    accountId: text("account_id").notNull().references(() => accounts.id),
    name: text("name").notNull(),
    contextNote: text("context_note"), // kurzer Kontextsatz; darf leer sein (bewusster Entwurf)
    status: setupStatusEnum("status").notNull().default("ENTWURF"),
    visibility: setupVisibilityEnum("visibility").notNull().default("MITGLIEDER"),
    bdUserId: text("bd_user_id").references(() => users.id), // null = „Zuordnung offen“
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("project_setups_account_idx").on(t.accountId)],
);

export const setupMemberships = pgTable(
  "setup_memberships",
  {
    setupId: text("setup_id").notNull().references(() => projectSetups.id),
    userId: text("user_id").notNull().references(() => users.id),
    contribution: membershipContributionEnum("contribution").notNull(),
    contributionNote: text("contribution_note"), // vereinbarter Beitrag, sachlich formuliert
    canEdit: boolean("can_edit").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.setupId, t.userId] })],
);

// ---------------------------------------------------------------------------
// People / Relationships
// ---------------------------------------------------------------------------

export const persons = pgTable("persons", {
  id: id(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  accountId: text("account_id").references(() => accounts.id),
  displayName: text("display_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  accessClass: accessClassEnum("access_class").notNull().default("ACCOUNT_TEAM"),
  retentionNote: text("retention_note"), // Aufbewahrungsentscheidung (offen bis Datenschutzfreigabe)
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const personFunctions = pgTable("person_functions", {
  id: id(),
  personId: text("person_id").notNull().references(() => persons.id),
  orgUnitId: text("org_unit_id").references(() => orgUnits.id),
  functionTitle: text("function_title").notNull(),
  knownResponsibility: text("known_responsibility"),
  validFrom: date("valid_from"),
  validTo: date("valid_to"),
  sourceId: text("source_id").references((): import("drizzle-orm/pg-core").AnyPgColumn => sources.id),
  createdAt: createdAt(),
});

export const relationships = pgTable("relationships", {
  id: id(),
  personId: text("person_id").notNull().references(() => persons.id),
  holderUserId: text("holder_user_id").notNull().references(() => users.id), // Beziehungshalter bei Verve
  setupId: text("setup_id").references(() => projectSetups.id),
  state: relationshipStateEnum("state").notNull().default("NAME_FUNKTION_BEKANNT"),
  contextNote: text("context_note"),
  evidenceSourceId: text("evidence_source_id").references((): import("drizzle-orm/pg-core").AnyPgColumn => sources.id),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

// ---------------------------------------------------------------------------
// Knowledge / Sources
// ---------------------------------------------------------------------------

export const sources = pgTable(
  "sources",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    setupId: text("setup_id").references(() => projectSetups.id),
    type: sourceTypeEnum("type").notNull(),
    title: text("title").notNull(),
    body: text("body"), // Text der Notiz / des Protokolls (Ebene 1: Originalquelle)
    origin: text("origin"), // z. B. „Weekly 2026-09-18“, „manuell“
    externalKey: text("external_key"), // externe ID bei Importen (idempotent)
    sourceTime: timestamp("source_time", { withTimezone: true }), // Zeitpunkt der Quelle
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    accessClass: accessClassEnum("access_class").notNull().default("SETUP"),
    isLocked: boolean("is_locked").notNull().default(false), // Sperrung (nicht Löschung)
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sources_external_key_uq").on(t.workspaceId, t.type, t.externalKey)],
);

export const assertions = pgTable(
  "assertions",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    setupId: text("setup_id").references(() => projectSetups.id),
    subjectType: text("subject_type").notNull(), // z. B. ACCOUNT, SETUP, PERSON, ASSIGNMENT
    subjectId: text("subject_id"),
    content: text("content").notNull(),
    epistemicStatus: epistemicStatusEnum("epistemic_status").notNull().default("UNGEPRUEFT_EXTRAHIERT"),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    confirmedBy: text("confirmed_by").references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("assertions_setup_idx").on(t.setupId)],
);

export const assertionEvidence = pgTable(
  "assertion_evidence",
  {
    assertionId: text("assertion_id").notNull().references(() => assertions.id),
    sourceId: text("source_id").notNull().references(() => sources.id),
    excerpt: text("excerpt"),
    evidenceKind: text("evidence_kind").notNull().default("BELEG"), // BELEG | WIDERSPRUCH | KONTEXT
  },
  (t) => [primaryKey({ columns: [t.assertionId, t.sourceId] })],
);

// ---------------------------------------------------------------------------
// Signals / Actions / Handovers
// ---------------------------------------------------------------------------

export const signals = pgTable(
  "signals",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    setupId: text("setup_id").notNull().references(() => projectSetups.id),
    observation: text("observation").notNull(), // sichere Beobachtung
    relevanceHypothesis: text("relevance_hypothesis"), // Vermutung, klar getrennt
    usageLimit: text("usage_limit"), // Nutzungsgrenze („nicht gegenüber Kunde erwähnen“ etc.)
    status: signalStatusEnum("status").notNull().default("NEU"),
    ownerUserId: text("owner_user_id").references(() => users.id), // wer die Prüfung übernommen hat
    sourceId: text("source_id").references(() => sources.id),
    closedReason: text("closed_reason"),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("signals_setup_idx").on(t.setupId)],
);

export const actions = pgTable(
  "actions",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    setupId: text("setup_id").references(() => projectSetups.id),
    signalId: text("signal_id").references(() => signals.id),
    title: text("title").notNull(),
    agreement: text("agreement"), // was vereinbart wurde
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    status: actionStatusEnum("status").notNull().default("VORGESCHLAGEN"),
    dueDate: date("due_date"),
    result: text("result"),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("actions_owner_idx").on(t.ownerUserId), index("actions_setup_idx").on(t.setupId)],
);

export const handovers = pgTable(
  "handovers",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    setupId: text("setup_id").references(() => projectSetups.id),
    subjectType: handoverSubjectEnum("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    senderUserId: text("sender_user_id").notNull().references(() => users.id),
    receiverUserId: text("receiver_user_id").notNull().references(() => users.id),
    context: text("context").notNull(),
    proven: text("proven"), // was ist belegt
    open: text("open"), // was bleibt offen
    allowedUse: text("allowed_use"), // was darf verwendet/weitergegeben werden
    responsibility: text("responsibility").notNull(), // welche konkrete Verantwortung übernommen werden soll
    nextStep: text("next_step"),
    dueDate: date("due_date"),
    feedbackChannel: text("feedback_channel"),
    status: handoverStatusEnum("status").notNull().default("ANGEFRAGT"),
    responseNote: text("response_note"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("handovers_receiver_idx").on(t.receiverUserId), index("handovers_subject_idx").on(t.subjectType, t.subjectId)],
);

// ---------------------------------------------------------------------------
// Kontaktwege (Briefing 8.4 / A5) – belegt, geplant und hypothetisch klar getrennt
// ---------------------------------------------------------------------------

export const accessPlanStatusEnum = pgEnum("access_plan_status", ["ENTWURF", "IN_ABSTIMMUNG", "VERMITTLUNG_ZUGESAGT", "VORGESTELLT", "NICHT_MOEGLICH", "BEENDET"]);
export const accessStepKindEnum = pgEnum("access_step_kind", [
  "BELEGT", // bestehende, belegte Beziehung
  "GEPLANT", // Vermittlung angefragt / zugesagt, noch nicht erfolgt
  "HYPOTHETISCH", // angenommene Verbindung ohne Beleg
]);
export const mediationReadinessEnum = pgEnum("mediation_readiness", ["UNBEKANNT", "ANGEFRAGT", "BEREIT", "ABGELEHNT"]);

export const accessPlans = pgTable(
  "access_plans",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    setupId: text("setup_id").notNull().references(() => projectSetups.id),
    /** Zielperson – oder nur gesuchte Funktion, wenn die Person unbekannt ist */
    targetPersonId: text("target_person_id").references(() => persons.id),
    targetFunction: text("target_function"),
    occasion: text("occasion").notNull(), // fachlicher Anlass
    desiredOutcome: text("desired_outcome"), // angestrebtes Gesprächsergebnis
    allowedIntroContent: text("allowed_intro_content"), // erlaubter Inhalt der Vorstellung
    alternative: text("alternative"), // falls dieser Weg nicht möglich ist
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    nextStep: text("next_step"),
    status: accessPlanStatusEnum("status").notNull().default("ENTWURF"),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("access_plans_setup_idx").on(t.setupId)],
);

export const accessPlanSteps = pgTable(
  "access_plan_steps",
  {
    id: id(),
    accessPlanId: text("access_plan_id").notNull().references(() => accessPlans.id),
    position: integer("position").notNull(),
    /** Ausgangspunkt: Verve-Beziehungshalter (Schritt 1) oder vermittelnde Person */
    fromUserId: text("from_user_id").references(() => users.id),
    fromPersonId: text("from_person_id").references(() => persons.id),
    toPersonId: text("to_person_id").notNull().references(() => persons.id),
    kind: accessStepKindEnum("kind").notNull().default("HYPOTHETISCH"),
    /** Beleg der Beziehung – bei kind=BELEGT Pflicht (Relationship oder Quelle) */
    relationshipId: text("relationship_id").references(() => relationships.id),
    evidenceSourceId: text("evidence_source_id").references(() => sources.id),
    mediationReadiness: mediationReadinessEnum("mediation_readiness").notNull().default("UNBEKANNT"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("access_plan_steps_plan_idx").on(t.accessPlanId)],
);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    actorUserId: text("actor_user_id").references(() => users.id),
    action: text("action").notNull(), // z. B. setup.created, signal.taken_over
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    changes: jsonb("changes"), // minimal erforderliche Änderungsinformation, keine Rohquellen
  },
  (t) => [index("audit_events_object_idx").on(t.objectType, t.objectId)],
);

export type Role = (typeof roleEnum.enumValues)[number];
export type AccessClass = (typeof accessClassEnum.enumValues)[number];
export type SignalStatus = (typeof signalStatusEnum.enumValues)[number];
export type ActionStatus = (typeof actionStatusEnum.enumValues)[number];
export type HandoverStatus = (typeof handoverStatusEnum.enumValues)[number];
export type SetupStatus = (typeof setupStatusEnum.enumValues)[number];
export type MembershipContribution = (typeof membershipContributionEnum.enumValues)[number];
export type RelationshipState = (typeof relationshipStateEnum.enumValues)[number];
export type AccessStepKind = (typeof accessStepKindEnum.enumValues)[number];
export type AccessPlanStatus = (typeof accessPlanStatusEnum.enumValues)[number];
