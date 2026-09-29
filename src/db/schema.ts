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
  real,
  date,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums (fachliche Zustände, Briefing Kap. 9.2 / 15.3 / 16.2)
// ---------------------------------------------------------------------------

export const roleEnum = pgEnum("role", ["ANKER", "BD", "PRINCIPAL", "CEO", "ADMIN", "SALES_OPS"]);
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

export const sourceTypeEnum = pgEnum("source_type", ["NOTIZ", "PROTOKOLL", "EMAIL", "TERMIN", "OEFFENTLICH", "DOKUMENT", "INTERVIEW"]);
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

/** Kanal einer Aktion (Etappe 18) – LINKEDIN ohne Anbindung, nur zur Einordnung und für den Profillink. */
export const actionChannelEnum = pgEnum("action_channel", ["GESPRAECH", "TELEFON", "EMAIL", "LINKEDIN", "SONSTIGE"]);

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
    externalSubject: text("external_subject"), // stabile Kennung des Identitätsanbieters (OIDC sub/oid)
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.workspaceId, t.email), uniqueIndex("users_external_subject_uq").on(t.externalSubject)],
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
  /** Beschaffungsweg (Etappe 26): direkt, über Vermittler oder Rahmenvertrag – bestimmt Zugang, Angebotsweg und Marge */
  procurementChannel: text("procurement_channel"), // DIREKT | VERMITTLER | RAHMENVERTRAG | null = unbekannt
  intermediaryName: text("intermediary_name"),
  procurementNote: text("procurement_note"),
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
  /** Manuell gepflegter Link zum bekannten LinkedIn-Profil (Etappe 18) – keine Anbindung, nur Referenz/Deep-Link. */
  linkedinUrl: text("linkedin_url"),
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
    opportunityId: text("opportunity_id").references((): AnyPgColumn => opportunities.id), // Wofür (Etappe 10)
    observation: text("observation").notNull(), // sichere Beobachtung
    relevanceHypothesis: text("relevance_hypothesis"), // Vermutung, klar getrennt
    usageLimit: text("usage_limit"), // Nutzungsgrenze („nicht gegenüber Kunde erwähnen“ etc.)
    status: signalStatusEnum("status").notNull().default("NEU"),
    ownerUserId: text("owner_user_id").references(() => users.id), // wer die Prüfung übernommen hat
    sourceId: text("source_id").references(() => sources.id),
    reviewId: text("review_id").references((): import("drizzle-orm/pg-core").AnyPgColumn => reviews.id), // im Weekly erfasst
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
    opportunityId: text("opportunity_id").references((): AnyPgColumn => opportunities.id), // Wofür (Etappe 10)
    setupId: text("setup_id").references(() => projectSetups.id),
    signalId: text("signal_id").references(() => signals.id),
    reviewId: text("review_id").references((): import("drizzle-orm/pg-core").AnyPgColumn => reviews.id), // im Weekly vereinbart
    title: text("title").notNull(),
    agreement: text("agreement"), // was vereinbart wurde
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    status: actionStatusEnum("status").notNull().default("VORGESCHLAGEN"),
    dueDate: date("due_date"),
    result: text("result"),
    /** Kanal der Aktion (Etappe 18); null = nicht angegeben. Bei LINKEDIN kann ein Profillink hinterlegt werden. */
    channel: actionChannelEnum("channel"),
    linkedinUrl: text("linkedin_url"),
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
// Reviews / Weeklys (Briefing 11) – versionierter, bestätigter Stand
// ---------------------------------------------------------------------------

export const reviewTypeEnum = pgEnum("review_type", ["BD_ANKER_WEEKLY", "PRINCIPAL_BD_WEEKLY", "CEO_PRINCIPAL_ZIELGESPRAECH"]);
export const reviewStatusEnum = pgEnum("review_status", ["GEPLANT", "IN_VORBEREITUNG", "LAUFEND", "BESTAETIGUNG_OFFEN", "BESTAETIGT"]);

export const reviews = pgTable(
  "reviews",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    type: reviewTypeEnum("type").notNull().default("BD_ANKER_WEEKLY"),
    setupId: text("setup_id").references(() => projectSetups.id), // BD/Anker-Weekly ist setup-bezogen
    accountId: text("account_id").references(() => accounts.id),
    title: text("title").notNull(),
    scheduledFor: date("scheduled_for").notNull(),
    status: reviewStatusEnum("status").notNull().default("GEPLANT"),
    noteDraft: text("note_draft"), // gemeinsame Freitextnotiz – automatisch nur als Entwurf gespeichert
    confirmedVersionId: text("confirmed_version_id"), // aktuell gültige bestätigte Version
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("reviews_setup_idx").on(t.setupId), index("reviews_scheduled_idx").on(t.scheduledFor)],
);

export const reviewParticipants = pgTable(
  "review_participants",
  {
    reviewId: text("review_id").notNull().references(() => reviews.id),
    userId: text("user_id").notNull().references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.reviewId, t.userId] })],
);

export const reviewVersions = pgTable(
  "review_versions",
  {
    id: id(),
    reviewId: text("review_id").notNull().references(() => reviews.id),
    versionNo: integer("version_no").notNull(),
    note: text("note"), // bestätigte Notiz
    /** Bestätigter Stand: IDs der im Weekly erfassten Hinweise, Aktionen, Entscheidungen sowie Zusammenfassung offener Punkte */
    snapshot: jsonb("snapshot").notNull(),
    confirmedBy: text("confirmed_by").notNull().references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    supersedesVersionId: text("supersedes_version_id"),
    correctionNote: text("correction_note"), // Grund der Korrektur bei Folgeversionen
  },
  (t) => [uniqueIndex("review_versions_no_uq").on(t.reviewId, t.versionNo)],
);

export const decisions = pgTable(
  "decisions",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    setupId: text("setup_id").references(() => projectSetups.id),
    reviewId: text("review_id").references(() => reviews.id),
    content: text("content").notNull(),
    scope: text("scope"), // Geltungsbereich
    rationale: text("rationale"),
    decidedByUserIds: text("decided_by_user_ids").array().notNull().default(sql`'{}'::text[]`),
    decidedOn: date("decided_on").notNull().defaultNow(),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("decisions_setup_idx").on(t.setupId)],
);

// ---------------------------------------------------------------------------
// Accountplan (Briefing 7 / A1 / A13): Prioritäten und gespeicherte Stände – kein zweiter Datenbestand
// ---------------------------------------------------------------------------

export const priorityKindEnum = pgEnum("priority_kind", ["VERLAENGERN", "AUSWEITEN", "VERTIEFEN", "UEBERTRAGEN", "REAKTIVIEREN"]);
export const priorityStatusEnum = pgEnum("priority_status", ["VORGESCHLAGEN", "VEREINBART", "ZURUECKGESTELLT", "ERREICHT", "VERWORFEN"]);

export const accountPriorities = pgTable(
  "account_priorities",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    accountId: text("account_id").notNull().references(() => accounts.id),
    setupId: text("setup_id").references(() => projectSetups.id), // optionaler Bezug
    kind: priorityKindEnum("kind").notNull(),
    title: text("title").notNull(),
    rationale: text("rationale"), // Begründung
    prerequisites: text("prerequisites"), // Voraussetzungen (Zeit, Zugang, Freigaben …)
    goalReference: text("goal_reference"), // Bezug zu Portfolio-/Kundenziel (Zielobjekt folgt in Etappe 4)
    rank: integer("rank").notNull().default(100),
    status: priorityStatusEnum("status").notNull().default("VORGESCHLAGEN"),
    agreedByUserIds: text("agreed_by_user_ids").array().notNull().default(sql`'{}'::text[]`),
    deferredReason: text("deferred_reason"), // bewusst zurückgestellt – warum
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("account_priorities_account_idx").on(t.accountId)],
);

/** Gespeicherter Review-Stand des Accountplans – bleibt erhalten, auch wenn sich die Live-Übersicht ändert (7). */
export const accountPlanSnapshots = pgTable(
  "account_plan_snapshots",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    accountId: text("account_id").notNull().references(() => accounts.id),
    title: text("title").notNull(),
    content: jsonb("content").notNull(), // vollständiger Stand (siehe AccountPlanView)
    note: text("note"),
    confirmedBy: text("confirmed_by").notNull().references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_plan_snapshots_account_idx").on(t.accountId)],
);

// ---------------------------------------------------------------------------
// Artefakte (Briefing 12 / 15.2 ArtifactVersion): Vorlage, Datenbezug, Entwurf/Freigabe, Version, Quellen, Empfängerkreis
// ---------------------------------------------------------------------------

export const artifactVariantEnum = pgEnum("artifact_variant", ["INTERN", "EXTERN"]);
export const artifactStatusEnum = pgEnum("artifact_status", ["ENTWURF", "GEPRUEFT", "FREIGEGEBEN", "UEBERHOLT"]);

/** Registrierte Vorlagen – aus src/modules/artifacts/templates.ts synchronisiert (Konfiguration, später justierbar) */
export const artifactTemplates = pgTable("artifact_templates", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  responsible: text("responsible").notNull(),
  trigger: text("trigger").notNull(),
  scopeType: text("scope_type").notNull(),
  implementation: text("implementation").notNull(), // ANSICHT | TEXTENTWURF | FOLGT
  viewPath: text("view_path"),
  qualityCriterion: text("quality_criterion").notNull(),
  externalVariantAllowed: boolean("external_variant_allowed").notNull().default(false),
  sections: jsonb("sections").notNull(), // TemplateSection[]
  registryVersion: integer("registry_version").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: updatedAt(),
});

export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** Artefakt-Kette: alle Versionen eines Artefakts teilen dieselbe artifact_key */
    artifactKey: text("artifact_key").notNull(),
    versionNo: integer("version_no").notNull().default(1),
    templateCode: text("template_code").notNull().references(() => artifactTemplates.code),
    templateVersion: integer("template_version").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    setupId: text("setup_id").references(() => projectSetups.id),
    accountId: text("account_id").references(() => accounts.id),
    title: text("title").notNull(),
    variant: artifactVariantEnum("variant").notNull().default("INTERN"),
    content: jsonb("content").notNull(), // { [sectionKey]: string }
    sourceIds: text("source_ids").array().notNull().default(sql`'{}'::text[]`),
    audience: accessClassEnum("audience").notNull().default("SETUP"), // zulässiger Empfängerkreis
    status: artifactStatusEnum("status").notNull().default("ENTWURF"),
    supersedesId: text("supersedes_id"),
    createdBy: text("created_by").notNull().references(() => users.id),
    approvedBy: text("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("artifact_versions_key_idx").on(t.artifactKey), index("artifact_versions_setup_idx").on(t.setupId), uniqueIndex("artifact_versions_key_no_uq").on(t.artifactKey, t.versionNo)],
);

// ---------------------------------------------------------------------------
// KI-Vorschläge (Briefing 14), offene Fragen, KI-Aufträge
// ---------------------------------------------------------------------------

export const suggestionStatusEnum = pgEnum("suggestion_status", ["NEU", "GEPRUEFT", "ANGENOMMEN", "VERAENDERT", "ZURUECKGESTELLT", "ABGELEHNT", "ERLEDIGT", "UEBERHOLT"]);
export const suggestionTypeEnum = pgEnum("suggestion_type", ["BEOBACHTUNG", "AKTION", "ENTSCHEIDUNG", "OFFENE_FRAGE", "PERSON", "KONFLIKT", "KONTAKTAUFNAHME"]);
export const priorityCategoryEnum = pgEnum("priority_category", [
  "KONKRETE_ANFRAGE", // konkrete Anfrage oder vereinbarter Termin
  "BLOCKIERTE_AKTION",
  "NEUE_INFORMATION",
  "ZUGANGSLUECKE",
  "PLANUNGSANLASS",
  "VERBESSERUNGSIDEE",
]);
export const feedbackReasonEnum = pgEnum("feedback_reason", ["FALSCHE_ANNAHME", "BEREITS_ERLEDIGT", "UNPASSEND", "NICHT_ZULAESSIG", "KEIN_AKTUELLER_ANLASS", "SONSTIGES"]);
export const aiJobStatusEnum = pgEnum("ai_job_status", ["GESTARTET", "ERFOLGREICH", "ABGELEHNT", "FEHLER"]);

export const aiJobs = pgTable(
  "ai_jobs",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    type: text("type").notNull(), // z. B. STRUCTURE_NOTE
    actorUserId: text("actor_user_id").notNull().references(() => users.id),
    setupId: text("setup_id").references(() => projectSetups.id),
    reviewId: text("review_id").references(() => reviews.id),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    /** Hash des Eingabetexts – kein Rohtext in Auftragsprotokollen (16.4) */
    inputHash: text("input_hash").notNull(),
    inputChars: integer("input_chars").notNull(),
    status: aiJobStatusEnum("status").notNull().default("GESTARTET"),
    itemCount: integer("item_count"),
    rejectedCount: integer("rejected_count"), // schema-/quellenwidrige Elemente
    error: text("error"), // kurze, datensparsame Fehlermeldung
    dedupeKey: text("dedupe_key").notNull(), // Wiederholungskennung (Auftragsebene)
    /** Verbrauch laut Anbieter (Kostenspur, Etappe 6) */
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("ai_jobs_ws_started_idx").on(t.workspaceId, t.startedAt)],
);

// ---------------------------------------------------------------------------
// Etappe 6: Dokumente, Anlagevorschläge, KI-Aufgabenkonfiguration
// ---------------------------------------------------------------------------

export const extractStatusEnum = pgEnum("extract_status", ["OK", "TEILWEISE", "LEER", "FEHLER"]);

/** Hochgeladene Datei zu einer Quelle vom Typ DOKUMENT. Der extrahierte Text steht in sources.body. */
export const documents = pgTable(
  "documents",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    sourceId: text("source_id").notNull().references(() => sources.id),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    /** Pfad relativ zu UPLOAD_DIR; null, wenn die Datei entfernt wurde (Inhalt gelöscht) */
    storagePath: text("storage_path"),
    extractStatus: extractStatusEnum("extract_status").notNull(),
    extractNote: text("extract_note"),
    pageCount: integer("page_count"),
    uploadedBy: text("uploaded_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("documents_source_uq").on(t.sourceId)],
);

export const intakeStatusEnum = pgEnum("intake_status", ["ENTWURF", "UEBERNOMMEN", "VERWORFEN"]);

/** KI-Anlagevorschlag aus einem Dokument (Kunde, Ansprechpartner, Signale, Bedarfe) – wird erst durch Menschen übernommen. */
export const intakeProposals = pgTable(
  "intake_proposals",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    actorUserId: text("actor_user_id").notNull().references(() => users.id),
    sourceId: text("source_id").notNull().references(() => sources.id),
    aiJobId: text("ai_job_id").references(() => aiJobs.id),
    status: intakeStatusEnum("status").notNull().default("ENTWURF"),
    /** Vorschlag im Schema intakeProposalSchema (src/modules/ai/schemas.ts) */
    payload: jsonb("payload").notNull(),
    resultAccountId: text("result_account_id").references(() => accounts.id),
    resultSetupId: text("result_setup_id").references(() => projectSetups.id),
    /** Etappe 7: Herkunft (Dokument oder Interview) und Ziel-Setup bei Ergänzung eines bestehenden Setups */
    kind: text("kind").notNull().default("DOKUMENT"), // DOKUMENT | INTERVIEW
    interviewId: text("interview_id"),
    targetSetupId: text("target_setup_id").references(() => projectSetups.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

// ---------------------------------------------------------------------------
// Etappe 7: Interview, Personenbewertung
// ---------------------------------------------------------------------------

export const interviewKindEnum = pgEnum("interview_kind", ["KUNDE_NEU", "SETUP_ERGAENZUNG"]);
export const interviewStatusEnum = pgEnum("interview_status", ["LAUFEND", "ABGESCHLOSSEN", "VERWORFEN"]);

/** Geführtes Interview (Initialisierung eines Kunden oder Ergänzung eines Setups). Der Verlauf ist die Quelle. */
export const interviews = pgTable("interviews", {
  id: id(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  actorUserId: text("actor_user_id").notNull().references(() => users.id),
  kind: interviewKindEnum("kind").notNull(),
  setupId: text("setup_id").references(() => projectSetups.id), // bei SETUP_ERGAENZUNG
  status: interviewStatusEnum("status").notNull().default("LAUFEND"),
  title: text("title").notNull(),
  /** Abdeckung der Themen laut KI (Schlüssel → erledigt) */
  coverage: jsonb("coverage").notNull().default(sql`'{}'::jsonb`),
  questionCount: integer("question_count").notNull().default(0),
  sourceId: text("source_id").references(() => sources.id), // Transkript-Quelle nach Abschluss
  proposalId: text("proposal_id"), // intake_proposals.id nach Abschluss
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const interviewTurns = pgTable(
  "interview_turns",
  {
    id: id(),
    interviewId: text("interview_id").notNull().references(() => interviews.id),
    seq: integer("seq").notNull(),
    role: text("role").notNull(), // KI | NUTZER
    text: text("text").notNull(),
    /** Begründung/Ziel der Frage (nur bei KI) */
    rationale: text("rationale"),
    aiJobId: text("ai_job_id").references(() => aiJobs.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("interview_turns_seq_uq").on(t.interviewId, t.seq)],
);



/** Modellwahl je KI-Aufgabe (Verwaltung → KI). Der API-Schlüssel steht nie in der Datenbank. */
export const aiTaskSettings = pgTable(
  "ai_task_settings",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    task: text("task").notNull(), // STRUCTURE_NOTE, ANALYZE_DOCUMENT, …
    model: text("model").notNull(),
    temperature: real("temperature").notNull().default(0.2),
    maxOutputTokens: integer("max_output_tokens").notNull().default(4000),
    enabled: boolean("enabled").notNull().default(true),
    updatedBy: text("updated_by").notNull().references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("ai_task_settings_uq").on(t.workspaceId, t.task)],
);

export const suggestions = pgTable(
  "suggestions",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    type: suggestionTypeEnum("type").notNull(),
    opportunityId: text("opportunity_id").references((): AnyPgColumn => opportunities.id), // Wofür (Etappe 10)
    purpose: text("purpose"), // Wofür als Text, wenn (noch) keine Chance existiert
    title: text("title").notNull(),
    targetRole: text("target_role").notNull(), // adressierte Rolle (BD, ANKER, PRINCIPAL …)
    setupId: text("setup_id").notNull().references(() => projectSetups.id),
    reviewId: text("review_id").references(() => reviews.id),
    objectType: text("object_type"), // optionaler Bezug auf ein bestehendes Objekt
    objectId: text("object_id"),
    trigger: text("trigger").notNull(), // Beobachtung bzw. Auslöser
    sourceIds: text("source_ids").array().notNull().default(sql`'{}'::text[]`),
    evidenceQuote: text("evidence_quote").notNull(),
    observation: text("observation").notNull(), // Sachverhalt aus Quelle
    hypothesis: text("hypothesis"), // getrennt gekennzeichnete Idee
    uncertainty: text("uncertainty"),
    whyNow: text("why_now"),
    nextStep: text("next_step"),
    proposedQuestion: text("proposed_question"),
    expectedResult: text("expected_result"),
    proposedOwnerUserId: text("proposed_owner_user_id").references(() => users.id), // Vorschlag, nicht Zuweisung
    mentionedPersonName: text("mentioned_person_name"),
    priorityCategory: priorityCategoryEnum("priority_category").notNull().default("NEUE_INFORMATION"),
    dedupeKey: text("dedupe_key").notNull(),
    recheckTrigger: text("recheck_trigger"), // Anlass für erneute Prüfung
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    aiJobId: text("ai_job_id").references(() => aiJobs.id),
    status: suggestionStatusEnum("status").notNull().default("NEU"),
    feedbackReason: feedbackReasonEnum("feedback_reason"),
    feedbackNote: text("feedback_note"),
    decidedBy: text("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Bei Annahme erzeugtes Objekt (Signal, Aktion, Entscheidung, offene Frage) */
    acceptedObjectType: text("accepted_object_type"),
    acceptedObjectId: text("accepted_object_id"),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [index("suggestions_setup_status_idx").on(t.setupId, t.status), index("suggestions_dedupe_idx").on(t.setupId, t.dedupeKey)],
);

export const openQuestionStatusEnum = pgEnum("open_question_status", ["OFFEN", "IN_KLAERUNG", "BEANTWORTET", "ZURUECKGESTELLT"]);

export const openQuestions = pgTable(
  "open_questions",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    setupId: text("setup_id").notNull().references(() => projectSetups.id),
    opportunityId: text("opportunity_id").references((): AnyPgColumn => opportunities.id), // Wofür (Etappe 10)
    question: text("question").notNull(),
    decisionImpact: text("decision_impact"), // Entscheidungsauswirkung
    possibleSource: text("possible_source"), // geeignete Quelle / Kontaktweg
    ownerUserId: text("owner_user_id").references(() => users.id),
    actionId: text("action_id").references(() => actions.id), // Klärungsaktion
    answer: text("answer"),
    answerSourceId: text("answer_source_id").references(() => sources.id),
    status: openQuestionStatusEnum("status").notNull().default("OFFEN"),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("open_questions_setup_idx").on(t.setupId)],
);

// ---------------------------------------------------------------------------
// Quellenanbindung (Briefing 13): Integrationen, Importe, Quellenversionen, Zuordnungsprüfliste
// ---------------------------------------------------------------------------

export const integrationProviderEnum = pgEnum("integration_provider", ["MICROSOFT_GRAPH"]);
export const integrationStatusEnum = pgEnum("integration_status", ["VERBUNDEN_FIXTURE", "VERBUNDEN", "ABGELAUFEN", "WIDERRUFEN", "FEHLER"]);
export const importJobStatusEnum = pgEnum("import_job_status", ["VORGESCHLAGEN", "UEBERNOMMEN", "AUSGEWERTET", "BESTAETIGT", "FEHLER", "VERWORFEN"]);
export const importKindEnum = pgEnum("import_kind", ["PROTOKOLL_TEXT", "PROTOKOLL_DATEI", "MAIL", "TERMIN"]);

/** Persönliche Verbindung eines Nutzers zu einem Anbieter – Tokens nur als verschlüsselte Referenz (13.4) */
export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    userId: text("user_id").notNull().references(() => users.id),
    provider: integrationProviderEnum("provider").notNull(),
    /** Tatsächlich gewährte Berechtigungen (Scopes), zur Anzeige (13.4 „Berechtigungen anzeigen“) */
    grantedScopes: text("granted_scopes").array().notNull().default(sql`'{}'::text[]`),
    /** Referenz auf den serverseitig verschlüsselten Token-Speicher; nie der Token selbst */
    tokenRef: text("token_ref"),
    accountLabel: text("account_label"), // z. B. Postfach-Anzeigename
    status: integrationStatusEnum("status").notNull().default("VERBUNDEN_FIXTURE"),
    fixtureMode: boolean("fixture_mode").notNull().default(true), // kein echter Abruf
    lastSuccessfulFetchAt: timestamp("last_successful_fetch_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("integration_connections_user_provider_uq").on(t.userId, t.provider)],
);

export const importJobs = pgTable(
  "import_jobs",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    actorUserId: text("actor_user_id").notNull().references(() => users.id),
    kind: importKindEnum("kind").notNull(),
    connectionId: text("connection_id").references(() => integrationConnections.id),
    /** Externe Kennung (Mail-/Termin-ID bzw. Datei-Hash) – idempotent je Arbeitsraum */
    externalKey: text("external_key").notNull(),
    title: text("title").notNull(),
    setupId: text("setup_id").references(() => projectSetups.id), // Zielsetup (vorgeschlagen/gewählt)
    accountId: text("account_id").references(() => accounts.id),
    accessClass: accessClassEnum("access_class").notNull().default("PERSOENLICH"), // interner Empfängerkreis
    sourceId: text("source_id").references(() => sources.id), // erzeugte Quelle nach Übernahme
    aiJobId: text("ai_job_id").references(() => aiJobs.id),
    status: importJobStatusEnum("status").notNull().default("VORGESCHLAGEN"),
    scopeSummary: text("scope_summary"), // Importumfang (z. B. „1 Mail, 2 Anhänge ausgeschlossen“)
    warnings: text("warnings").array().notNull().default(sql`'{}'::text[]`), // z. B. sensible Inhalte, HTML entfernt
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex("import_jobs_external_uq").on(t.workspaceId, t.kind, t.externalKey), index("import_jobs_actor_idx").on(t.actorUserId)],
);

/** Quellenversion: bei erneutem Import mit verändertem Inhalt entsteht eine neue Version, die alte bleibt (15.3) */
export const sourceVersions = pgTable(
  "source_versions",
  {
    id: id(),
    sourceId: text("source_id").notNull().references(() => sources.id),
    versionNo: integer("version_no").notNull(),
    body: text("body"),
    contentHash: text("content_hash").notNull(),
    importJobId: text("import_job_id").references(() => importJobs.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("source_versions_no_uq").on(t.sourceId, t.versionNo)],
);

export const mergeReviewStatusEnum = pgEnum("merge_review_status", ["OFFEN", "ZUSAMMENGEFUEHRT", "NEUE_PERSON", "IGNORIERT"]);

/** Prüfliste unsicherer Zusammenführungen: gleiche Namen sind kein Identitätsbeweis (13.4, Testfall 19.2) */
export const mergeReviewItems = pgTable(
  "merge_review_items",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    importJobId: text("import_job_id").notNull().references(() => importJobs.id),
    mentionedName: text("mentioned_name").notNull(),
    mentionedEmail: text("mentioned_email"),
    candidatePersonIds: text("candidate_person_ids").array().notNull().default(sql`'{}'::text[]`),
    status: mergeReviewStatusEnum("status").notNull().default("OFFEN"),
    decidedPersonId: text("decided_person_id").references(() => persons.id),
    decidedBy: text("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("merge_review_items_job_idx").on(t.importJobId)],
);

// ---------------------------------------------------------------------------
// Führungsebenen (Briefing 10.2, 11.2–11.4): Unterstützungsaufträge, Ziele, vertrauliche Notizen
// ---------------------------------------------------------------------------

export const supportRequestStatusEnum = pgEnum("support_request_status", ["ANGEFRAGT", "ANGENOMMEN", "ZURUECKGEGEBEN", "ERLEDIGT", "ZURUECKGEZOGEN"]);

/** Begrenzter, konkreter Unterstützungsauftrag an den Principal – operative Fallverantwortung bleibt beim BD (10.2, F13) */
export const supportRequests = pgTable(
  "support_requests",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    requesterUserId: text("requester_user_id").notNull().references(() => users.id),
    addresseeUserId: text("addressee_user_id").notNull().references(() => users.id),
    setupId: text("setup_id").references(() => projectSetups.id),
    accountId: text("account_id").references(() => accounts.id),
    reviewId: text("review_id").references(() => reviews.id),
    task: text("task").notNull(), // z. B. „Sparring zur Gesprächsfrage“
    context: text("context"),
    dueDate: date("due_date"),
    status: supportRequestStatusEnum("status").notNull().default("ANGEFRAGT"),
    responseNote: text("response_note"),
    result: text("result"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("support_requests_addressee_idx").on(t.addresseeUserId), index("support_requests_setup_idx").on(t.setupId)],
);

export const goalStatusEnum = pgEnum("goal_status", ["ENTWURF", "ZUR_ABSTIMMUNG", "VEREINBART", "GEAENDERT", "BEENDET"]);
/** Rollenfamilien des Verve-Standardrollenkatalogs (hier schon deklariert, weil goal_versions optional darauf zeigt). */
export const roleFamilyEnum = pgEnum("role_family", ["DELIVERY_MANAGEMENT", "AGILE_LEADERSHIP", "BUSINESS_ANALYSE", "SOLUTION_ARCHITEKTUR", "TEST_QS"]);

/** Ziel (11.3) – Kopf; Inhalte liegen versioniert in goal_versions */
export const goals = pgTable(
  "goals",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    title: text("title").notNull(),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id), // Verantwortliche (i. d. R. Principal)
    accountId: text("account_id").references(() => accounts.id), // optionaler Kundenbezug
    status: goalStatusEnum("status").notNull().default("ENTWURF"),
    currentVersionId: text("current_version_id"),
    /** Bestätigende Personen der aktuellen Vereinbarung (CEO + Principal) */
    agreedByUserIds: text("agreed_by_user_ids").array().notNull().default(sql`'{}'::text[]`),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("goals_owner_idx").on(t.ownerUserId)],
);

export const goalVersions = pgTable(
  "goal_versions",
  {
    id: id(),
    goalId: text("goal_id").notNull().references(() => goals.id),
    versionNo: integer("version_no").notNull(),
    desiredOutcome: text("desired_outcome").notNull(),
    scope: text("scope"), // Geltungsbereich
    periodFrom: date("period_from"),
    periodTo: date("period_to"),
    successCriterion: text("success_criterion"), // beobachtbares Kriterium / Messgröße
    baseline: text("baseline"), // Ausgangslage – „unbekannt bleibt unbekannt“
    baselineSourceId: text("baseline_source_id").references(() => sources.id),
    targetValue: text("target_value"), // nur, falls tatsächlich vereinbart; sonst null
    /** Accountziel (Etappe 11): optionales Rollenziel, wenn das Ziel eine Rollenfamilie/Anzahl bei einem Kunden ist.
     *  horizon ist Freitext wie bei Chancen (z. B. „Q4 2027“) – periodFrom/periodTo bleiben echte Kalenderdaten. */
    roleFamily: roleFamilyEnum("role_family"),
    targetHeadcount: integer("target_headcount"),
    horizon: text("horizon"),
    supportNeeded: text("support_needed"),
    prerequisites: text("prerequisites"), // Zeit, Budget, Zugang, Fähigkeiten, Freigaben
    changeNote: text("change_note"), // Grund der Änderung ab Version 2
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("goal_versions_no_uq").on(t.goalId, t.versionNo)],
);

/** Beitrag eines Kunden/Setups/Vorhabens zu einem Ziel – erwartet und belegt getrennt */
export const goalContributions = pgTable(
  "goal_contributions",
  {
    id: id(),
    goalId: text("goal_id").notNull().references(() => goals.id),
    accountId: text("account_id").references(() => accounts.id),
    setupId: text("setup_id").references(() => projectSetups.id),
    priorityId: text("priority_id").references(() => accountPriorities.id),
    expectedContribution: text("expected_contribution"),
    evidencedContribution: text("evidenced_contribution"),
    evidenceSourceId: text("evidence_source_id").references(() => sources.id),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("goal_contributions_goal_idx").on(t.goalId)],
);

/** Vertrauliche Führungs-/Coachingnotizen (11.4): getrennt gespeichert, nur für den Teilnehmerkreis, nie in breiteren Ansichten */
export const confidentialNotes = pgTable(
  "confidential_notes",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    reviewId: text("review_id").references(() => reviews.id),
    setupId: text("setup_id").references(() => projectSetups.id),
    aboutUserId: text("about_user_id").references(() => users.id), // betroffene Mitarbeitende (optional)
    body: text("body").notNull(),
    audienceUserIds: text("audience_user_ids").array().notNull(), // expliziter Empfängerkreis
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("confidential_notes_review_idx").on(t.reviewId)],
);

// ---------------------------------------------------------------------------
// Bedarfe, Buyingcenter, Angebote, Aufträge, Startvoraussetzungen (Etappe 5; Briefing 8.3, 9.2, 9.3, 15.2)
// ---------------------------------------------------------------------------

export const opportunityStatusEnum = pgEnum("opportunity_status", [
  "ANTIZIPIERT", // Vermutung aus Beobachtungen – noch nicht vom Kunden ausgesprochen (Etappe 10)
  "IN_KLAERUNG",
  "BESTAETIGT",
  "PROFIL_ANGEBOT_VORGESTELLT",
  "AUSWAHL_BESTELLUNG",
  "BEAUFTRAGT",
  "ZURUECKGESTELLT",
  "BEENDET",
]);
/** Art einer Chance (Etappe 10, E-045): worauf die Arbeit beim Kunden hinausläuft. */
export const chanceKindEnum = pgEnum("chance_kind", ["VERVE_EXPERTE", "FREELANCER_EXPERTE", "AUSSCHREIBUNG"]);

/** Standardrollen-Katalog je Arbeitsraum (Verwaltung → Rollen); Seed aus dem Verve-Katalog. */
export const standardRoles = pgTable(
  "standard_roles",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    family: roleFamilyEnum("family").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("standard_roles_name_uq").on(t.workspaceId, t.name), index("standard_roles_family_idx").on(t.workspaceId, t.family)],
);

export const decisionRoleEnum = pgEnum("decision_role", [
  "BEDARFSTRAEGER",
  "FACHLICHE_BEWERTUNG",
  "BUDGETVERANTWORTUNG",
  "EINKAUF_VERTRAGSWEG",
  "ZUSAETZLICHE_FREIGABE",
  "UNTERSTUETZER_SPONSOR",
]);
export const offerStatusEnum = pgEnum("offer_status", ["ENTWURF", "GEPRUEFT", "VORGESTELLT", "RUECKMELDUNG_OFFEN", "AKZEPTIERT", "ABGELEHNT", "ZURUECKGEZOGEN"]);
export const orderStatusEnum = pgEnum("order_status", ["IN_VORBEREITUNG", "NACHWEISE_UNVOLLSTAENDIG", "BEAUFTRAGUNG_BESTAETIGT", "BEENDET_STORNIERT"]);
export const engagementStatusEnum = pgEnum("engagement_status", ["GEPLANT", "STARTBEREIT", "GESTARTET", "BEENDET"]);
export const requirementStatusEnum = pgEnum("requirement_status", ["OFFEN", "NACHWEIS_VORGELEGT", "BESTAETIGT", "NICHT_ANWENDBAR"]);

/** Bedarf/Chance (Opportunity): je Setup mehrere, unabhängige Zustände (F02); Fast-Track ohne vollständiges Setup (F08) */
export const opportunities = pgTable(
  "opportunities",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    accountId: text("account_id").notNull().references(() => accounts.id),
    setupId: text("setup_id").notNull().references(() => projectSetups.id),
    /** Kundeninitiative, auf die die Chance einzahlt (Etappe 26) – kein FK, damit die Tabelle unten stehen darf */
    initiativeId: text("initiative_id"),
    title: text("title").notNull(),
    needDescription: text("need_description").notNull(), // Bedarfsbeschreibung in Kundensprache
    trigger: text("trigger"), // konkreter Anlass (Identify Pain), nur dokumentiert
    status: opportunityStatusEnum("status").notNull().default("IN_KLAERUNG"),
    // Wofür (Etappe 10): Art der Chance, Standardrolle, Anzahl, Zeithorizont – alles außer der Art optional
    kind: chanceKindEnum("kind").notNull().default("VERVE_EXPERTE"),
    roleId: text("role_id").references(() => standardRoles.id),
    roleFamily: roleFamilyEnum("role_family"), // wenn nur die Familie bekannt ist (z. B. Ausschreibung)
    headcount: integer("headcount"),
    horizon: text("horizon"), // z. B. „Q1 2027“, „ab Mitte 2027“
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    fastTrack: boolean("fast_track").notNull().default(false), // direkte Anfrage (9.4)
    requestedAt: timestamp("requested_at", { withTimezone: true }), // Messstart Fast-Track, manuell gesetzt
    // Bestätigung (9.3): dokumentiert mit Quelle und Zeitpunkt
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedSourceId: text("confirmed_source_id").references(() => sources.id),
    confirmedNote: text("confirmed_note"),
    // MEDDPICC als optionale Qualifizierungshilfe (9.4) – keine Pflichtfelder, keine erfundenen Werte
    meddpicc: jsonb("meddpicc").$type<Record<string, string>>(),
    signalId: text("signal_id").references(() => signals.id), // hervorgegangen aus Hinweis
    statusReason: text("status_reason"),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("opportunities_setup_idx").on(t.setupId), index("opportunities_account_idx").on(t.accountId)],
);

/** Buyingcenter je Bedarf (8.3): Person oder offene Funktion ohne erfundene Person; eine Person kann mehrere Rollen haben */
export const decisionParticipations = pgTable(
  "decision_participations",
  {
    id: id(),
    opportunityId: text("opportunity_id").notNull().references(() => opportunities.id),
    role: decisionRoleEnum("role").notNull(),
    personId: text("person_id").references(() => persons.id), // null = Funktion bekannt, Person offen
    epistemicStatus: epistemicStatusEnum("epistemic_status").notNull().default("HYPOTHESE"),
    evidenceSourceId: text("evidence_source_id").references(() => sources.id),
    note: text("note"),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("decision_participations_opp_idx").on(t.opportunityId)],
);

/** Freigegebene Profilreferenz (15.2): nur Verweis auf ein freigegebenes Profil, kein Kandidatenmanagement */
export const candidateProfileReferences = pgTable(
  "candidate_profile_references",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    label: text("label").notNull(), // z. B. „Profil Senior Testkoordination (freigegeben 09/2026)“
    sourceRef: text("source_ref"), // Ablageort/Referenz, kein Inhalt
    availabilityNote: text("availability_note"),
    approvedBy: text("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
);

/** Angebot/Profilvorstellung (9.2): „Vorgestellt“ nur mit manuell bestätigtem Vorstellungsereignis oder Beleg (F09) */
export const offers = pgTable(
  "offers",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    opportunityId: text("opportunity_id").notNull().references(() => opportunities.id),
    title: text("title").notNull(),
    summary: text("summary"), // Inhalt in Kurzform; Kundentext als Artefakt
    artifactVersionId: text("artifact_version_id").references(() => artifactVersions.id),
    profileReferenceIds: text("profile_reference_ids").array().notNull().default(sql`'{}'::text[]`),
    status: offerStatusEnum("status").notNull().default("ENTWURF"),
    versionNo: integer("version_no").notNull().default(1),
    presentedAt: timestamp("presented_at", { withTimezone: true }),
    presentedTo: text("presented_to"), // Personen/Funktionen, denen tatsächlich vorgestellt wurde
    presentedSourceId: text("presented_source_id").references(() => sources.id),
    feedbackNote: text("feedback_note"),
    statusReason: text("status_reason"),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("offers_opp_idx").on(t.opportunityId)],
);

/** Auftrag (9.3): „Beauftragung bestätigt“ nur mit prüfbaren Bestell-/Vertragsnachweisen */
export const orders = pgTable(
  "orders",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    opportunityId: text("opportunity_id").notNull().references(() => opportunities.id),
    offerId: text("offer_id").references(() => offers.id),
    orderReference: text("order_reference"), // Bestell-/Vertragsnummer o. ä.
    evidenceSourceId: text("evidence_source_id").references(() => sources.id), // Nachweis als Quelle
    evidenceNote: text("evidence_note"),
    plannedStart: date("planned_start"),
    plannedEnd: date("planned_end"),
    /** Frist für die Verlängerungsentscheidung (z. B. Kündigungsfrist) – Etappe 23; bestimmt den Verlängerungsauslöser */
    renewalDeadline: date("renewal_deadline"),
    /** Operativer Berater im Einsatz (Etappe 26): Verve-Nutzer oder – z. B. Freelancer – nur Name */
    consultantUserId: text("consultant_user_id").references(() => users.id),
    consultantName: text("consultant_name"),
    status: orderStatusEnum("status").notNull().default("IN_VORBEREITUNG"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by").references(() => users.id),
    engagementStatus: engagementStatusEnum("engagement_status").notNull().default("GEPLANT"),
    startedAt: timestamp("started_at", { withTimezone: true }), // tatsächlich bestätigtes Ereignis, nicht Datum
    statusReason: text("status_reason"),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("orders_opp_idx").on(t.opportunityId)],
);

/** Startvoraussetzung je Auftrag/Einsatz (9.3): geltende Anforderung, Nachweis, prüfende Stelle, Status; keine leere Checkliste */
export const startRequirements = pgTable(
  "start_requirements",
  {
    id: id(),
    orderId: text("order_id").notNull().references(() => orders.id),
    requirement: text("requirement").notNull(),
    policyRef: text("policy_ref"), // Bezug zur geltenden Regel (Policyversion), falls freigegeben
    checkedBy: text("checked_by"), // prüfende Stelle (Funktion)
    evidenceSourceId: text("evidence_source_id").references(() => sources.id),
    evidenceNote: text("evidence_note"),
    status: requirementStatusEnum("status").notNull().default("OFFEN"),
    confirmedBy: text("confirmed_by").references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [index("start_requirements_order_idx").on(t.orderId)],
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

export const stanceEnum = pgEnum("stance", ["UNBEKANNT", "POSITIV", "NEUTRAL", "KRITISCH"]);
export const influenceEnum = pgEnum("influence", ["UNBEKANNT", "HOCH", "MITTEL", "NIEDRIG"]);

/**
 * Bewertung einer Person im Kontext eines Setups (an MEDDPICC angelehnt): Rolle in der Entscheidung, Haltung zu Verve,
 * Einfluss. Jede Bewertung ist Hypothese, bis sie mit Quelle bestätigt wird. Sichtbar für BD, Principal und den
 * Beziehungshalter (Anker) – nicht pauschal für CEO.
 */
export const personAssessments = pgTable(
  "person_assessments",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    personId: text("person_id").notNull().references(() => persons.id),
    setupId: text("setup_id").notNull().references(() => projectSetups.id),
    decisionRole: decisionRoleEnum("decision_role"),
    stance: stanceEnum("stance").notNull().default("UNBEKANNT"),
    influence: influenceEnum("influence").notNull().default("UNBEKANNT"),
    epistemicStatus: epistemicStatusEnum("epistemic_status").notNull().default("HYPOTHESE"),
    note: text("note"),
    sourceId: text("source_id").references(() => sources.id),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex("person_assessments_uq").on(t.personId, t.setupId)],
);

// ---------------------------------------------------------------------------
// Etappe 8: Assistent (Dialog je Nutzer und Kontext, Vorschlagskarten)
// ---------------------------------------------------------------------------

export const assistantContextEnum = pgEnum("assistant_context", ["GLOBAL", "ACCOUNT", "SETUP"]);

/** Ein Gesprächsfaden je Nutzer und Kontext. Der Verlauf wird bei der ersten Übernahme zur Quelle (INTERVIEW). */
export const assistantThreads = pgTable(
  "assistant_threads",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    userId: text("user_id").notNull().references(() => users.id),
    contextType: assistantContextEnum("context_type").notNull(),
    contextId: text("context_id"), // accountId oder setupId
    title: text("title").notNull(),
    /** Interview-Modus: der Assistent führt aktiv durch die neun Themen */
    interviewMode: boolean("interview_mode").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    sourceId: text("source_id").references(() => sources.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("assistant_threads_user_idx").on(t.userId, t.contextType, t.contextId)],
);

export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: id(),
    threadId: text("thread_id").notNull().references(() => assistantThreads.id),
    seq: integer("seq").notNull(),
    role: text("role").notNull(), // NUTZER | ASSISTENT | SYSTEM
    text: text("text").notNull(),
    /** Vorschlagskarten des Assistenten: AssistantCard[] (Typ, Felder, Status, Ergebnis) */
    cards: jsonb("cards").notNull().default(sql`'[]'::jsonb`),
    /** Fehlende Informationen, nach denen gefragt wurde */
    missing: jsonb("missing").notNull().default(sql`'[]'::jsonb`),
    aiJobId: text("ai_job_id").references(() => aiJobs.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("assistant_messages_seq_uq").on(t.threadId, t.seq)],
);

// ---------------------------------------------------------------------------
// Etappe 9: Strategiefaden je Setup – versionierte Hypothese (E-044)
// ---------------------------------------------------------------------------

export const strategyThreads = pgTable(
  "strategy_threads",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    setupId: text("setup_id").notNull().references(() => projectSetups.id),
    versionNo: integer("version_no").notNull(),
    summary: text("summary").notNull(),
    nextStep: text("next_step").notNull(),
    /** Züge: {title, why, ownerRole, evidenceQuote, done?} */
    moves: jsonb("moves").notNull().default([]),
    /** Risiken: {text, evidenceQuote} */
    risks: jsonb("risks").notNull().default([]),
    openQuestions: jsonb("open_questions").notNull().default([]),
    /** Textfassung der Lageanalyse zum Zeitpunkt der Fassung (Nachvollziehbarkeit) */
    basis: text("basis").notNull(),
    /** Stufe der Analyse zum Zeitpunkt der Fassung */
    stage: text("stage").notNull(),
    note: text("note"),
    aiJobId: text("ai_job_id").references(() => aiJobs.id),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("strategy_threads_version_uq").on(t.setupId, t.versionNo), index("strategy_threads_setup_idx").on(t.setupId)],
);

/**
 * Persönlicher KI-Berater je Chance (Etappe 15): analog zum Strategiefaden (Etappe 9), aber je Bedarf statt je
 * Setup – der nächste Schritt, um genau diese Chance zur Konvertierung zu bewegen. Versioniert, nie überschrieben.
 */
export const opportunityAdvice = pgTable(
  "opportunity_advice",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    opportunityId: text("opportunity_id").notNull().references(() => opportunities.id),
    versionNo: integer("version_no").notNull(),
    summary: text("summary").notNull(),
    nextStep: text("next_step").notNull(),
    /** Züge: {title, why, ownerRole, evidenceQuote, done?} */
    moves: jsonb("moves").notNull().default([]),
    /** Risiken: {text, evidenceQuote} */
    risks: jsonb("risks").notNull().default([]),
    openQuestions: jsonb("open_questions").notNull().default([]),
    /** Textfassung der Chancen-Lage zum Zeitpunkt der Fassung (Nachvollziehbarkeit) */
    basis: text("basis").notNull(),
    /** Status der Chance zum Zeitpunkt der Fassung */
    status: text("status").notNull(),
    note: text("note"),
    aiJobId: text("ai_job_id").references(() => aiJobs.id),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("opportunity_advice_version_uq").on(t.opportunityId, t.versionNo), index("opportunity_advice_opportunity_idx").on(t.opportunityId)],
);

/**
 * Buying-Center-Berater je Chance (Etappe 17, Anker-/BD-Wunsch „Assistent, der die Rollen durchgeht, berät und
 * Hinweise zum Lückenfüllen gibt"): analog zum Chancen-Berater (Etappe 15) eine versionierte Fassung – geht die
 * sechs Entscheidungsrollen (decision_role) durch und gibt je Lücke einen Hinweis. Die KI schlägt nur mit
 * Textstelle vor; gespeichert wird erst durch den Menschen. Status je Rolle wird nicht hier gespeichert, sondern
 * bei jedem Aufruf aus dem Buyingcenter (decision_participations) berechnet – kein zweiter Datenbestand.
 */
export const buyingCenterAdvice = pgTable(
  "buying_center_advice",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    opportunityId: text("opportunity_id").notNull().references(() => opportunities.id),
    versionNo: integer("version_no").notNull(),
    summary: text("summary").notNull(),
    /** je Rolle mit Inhalt: {role, hint, proposedPersonName?, evidenceQuote?} */
    roles: jsonb("roles").notNull().default([]),
    openQuestions: jsonb("open_questions").notNull().default([]),
    /** Textfassung von Chancen-Lage und Buyingcenter-Stand zum Zeitpunkt der Fassung (Nachvollziehbarkeit) */
    basis: text("basis").notNull(),
    /** Status der Chance zum Zeitpunkt der Fassung */
    status: text("status").notNull(),
    note: text("note"),
    aiJobId: text("ai_job_id").references(() => aiJobs.id),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("buying_center_advice_version_uq").on(t.opportunityId, t.versionNo), index("buying_center_advice_opportunity_idx").on(t.opportunityId)],
);

/**
 * Öffentliche Unternehmensrecherche je Kunde (Etappe 16): eng begrenzte Ausnahme von „die KI recherchiert nicht
 * im Internet“ – ausschließlich öffentliche Firmendaten (Branche, Sitz, Größenordnung, Rechtsform), NIE benannte
 * Einzelpersonen. Fixture-Anbieter analog zur Microsoft-Graph-Integration (Etappe 3B): Struktur und Begrenzung
 * stehen, ein echter Web-Suchdienst ist bewusst nicht angebunden. Nur die jeweils letzte Fassung je Kunde – kein
 * Verlauf nötig, es handelt sich um Anzeigedaten, keine geprüften Vorschläge in den Domänenobjekten.
 */
export const companyResearch = pgTable(
  "company_research",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    accountId: text("account_id").notNull().references(() => accounts.id),
    companyName: text("company_name").notNull(),
    /** Öffentliche Einzelangaben: {label, value, sourceLabel, sourceUrl, asOf} */
    facts: jsonb("facts").notNull().default([]),
    note: text("note").notNull(),
    fixtureMode: boolean("fixture_mode").notNull().default(true),
    fetchedBy: text("fetched_by").notNull().references(() => users.id),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("company_research_account_uq").on(t.accountId)],
);

// ---------------------------------------------------------------------------
// Vorgehensmuster / Playbooks (Etappe 20): Standard-Vorgehen als Gerüst, nie als Pflichtschleuse.
// Ein Muster besteht aus Schritten; ein Lauf wendet es auf einen Kunden (über ein Setup) oder eine Chance an.
// Laufschritte sind eine Momentaufnahme der Musterschritte – spätere Änderungen am Muster verändern
// laufende Vorgehen nicht. Jeder aktive Schritt ist eine normale Aktion (Meine Arbeit, Weekly).
// ---------------------------------------------------------------------------

export const playbookScopeEnum = pgEnum("playbook_scope", ["ACCOUNT", "SETUP", "OPPORTUNITY"]);
export const playbookRunStatusEnum = pgEnum("playbook_run_status", ["AKTIV", "ABGESCHLOSSEN", "ZURUECKGESTELLT"]);
export const playbookStepStatusEnum = pgEnum("playbook_step_status", ["WARTET", "OFFEN", "ERLEDIGT", "UEBERSPRUNGEN"]);

export const playbooks = pgTable(
  "playbooks",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    code: text("code").notNull(), // stabil, z. B. ALTKUNDEN_REAKTIVIERUNG; eigene Muster: EIGEN_<id>
    name: text("name").notNull(),
    description: text("description"),
    scope: playbookScopeEnum("scope").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").references(() => users.id), // null = Standardmuster
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex("playbooks_code_uq").on(t.workspaceId, t.code)],
);

export const playbookSteps = pgTable(
  "playbook_steps",
  {
    id: id(),
    playbookId: text("playbook_id").notNull().references(() => playbooks.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    goal: text("goal"), // Wozu dient der Schritt?
    meddpicc: text("meddpicc"), // Bezug, z. B. "Metrics, Champion"
    suggestedAction: text("suggested_action"), // Was konkret tun?
    doneCriterion: text("done_criterion"), // Woran erkennt man, dass der Schritt erledigt ist?
    dueInDays: integer("due_in_days"), // Richtwert ab Aktivierung des Schritts
    /** Wer übernimmt den Schritt: VERANTWORTLICH (i. d. R. BD) oder SALES_OPS (Vorbereitung) – Etappe 22 */
    assignee: text("assignee").notNull().default("VERANTWORTLICH"),
    createdAt: createdAt(),
  },
  (t) => [index("playbook_steps_playbook_idx").on(t.playbookId)],
);

export const playbookRuns = pgTable(
  "playbook_runs",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    playbookId: text("playbook_id").notNull().references(() => playbooks.id),
    playbookName: text("playbook_name").notNull(), // Momentaufnahme
    accountId: text("account_id").notNull().references(() => accounts.id),
    setupId: text("setup_id").notNull().references(() => projectSetups.id),
    opportunityId: text("opportunity_id").references((): AnyPgColumn => opportunities.id),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    /** Sales Operations für die Vorbereitungsschritte (optional) */
    salesOpsUserId: text("sales_ops_user_id").references(() => users.id),
    status: playbookRunStatusEnum("status").notNull().default("AKTIV"),
    closedReason: text("closed_reason"),
    startedBy: text("started_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("playbook_runs_account_idx").on(t.accountId), index("playbook_runs_setup_idx").on(t.setupId)],
);

export const playbookRunSteps = pgTable(
  "playbook_run_steps",
  {
    id: id(),
    runId: text("run_id").notNull().references(() => playbookRuns.id, { onDelete: "cascade" }),
    stepId: text("step_id"), // Herkunft (kein FK: Musterschritt darf später gelöscht werden)
    position: integer("position").notNull(),
    title: text("title").notNull(),
    goal: text("goal"),
    meddpicc: text("meddpicc"),
    suggestedAction: text("suggested_action"),
    doneCriterion: text("done_criterion"),
    dueInDays: integer("due_in_days"),
    assignee: text("assignee").notNull().default("VERANTWORTLICH"),
    status: playbookStepStatusEnum("status").notNull().default("WARTET"),
    actionId: text("action_id").references(() => actions.id),
    result: text("result"),
    skipReason: text("skip_reason"),
    completedBy: text("completed_by").references(() => users.id),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Schritt-Assistent: Entwürfe (Mail, Gesprächsleitfaden, Metriken, Fragen …) – Vorschläge, nie versendet */
    drafts: jsonb("drafts"),
    draftsNote: text("drafts_note"),
    draftsAiJobId: text("drafts_ai_job_id"),
    draftsAt: timestamp("drafts_at", { withTimezone: true }),
  },
  (t) => [index("playbook_run_steps_run_idx").on(t.runId), index("playbook_run_steps_action_idx").on(t.actionId)],
);

// ---------------------------------------------------------------------------
// Strategischer Fokus & Standardaufgaben (Etappe 21): das Management setzt einen Fokus (zuerst: Wachstum über
// Freelancer). Er wird in alle KI-Agenten eingespeist und erzeugt Standardaufgaben als Vorschläge.
// ---------------------------------------------------------------------------

export const workspaceFocus = pgTable("workspace_focus", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id),
  focusText: text("focus_text").notNull(),
  /** Freelancer-Hebel: KI-Hinweise, Standardaufgaben und Kennzahlen zum Freelancer-Wachstum */
  freelancerLever: boolean("freelancer_lever").notNull().default(true),
  weeklyQuestion: text("weekly_question"),
  updatedBy: text("updated_by").references(() => users.id),
  updatedAt: updatedAt(),
  version: version(),
});

export const standardTasks = pgTable(
  "standard_tasks",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** Eindeutiger Anlass, z. B. fl-check:opp:<id> – verhindert Doppelungen */
    key: text("key").notNull(),
    kind: text("kind").notNull(), // FL_CHECK_CHANCE | FL_AUSWEITUNG | FL_POTENZIAL
    accountId: text("account_id").references(() => accounts.id),
    actionId: text("action_id").references(() => actions.id),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("standard_tasks_key_uq").on(t.workspaceId, t.key), index("standard_tasks_owner_idx").on(t.ownerUserId)],
);

// ---------------------------------------------------------------------------
// Kunden-Health-Check (Etappe 23): „Wie sicher sitzen wir im Sattel?“ – transparente Regeln statt KI-Score.
// Antworten aus dem geführten Interview je Kunde; Verlauf als Momentaufnahmen für den Trend.
// ---------------------------------------------------------------------------

export const accountHealth = pgTable("account_health", {
  accountId: text("account_id").primaryKey().references(() => accounts.id),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  /** { feedback?: {tone,date,note,at,by}, listing?: {...}, procurement?: {...}, risks?: {...} } */
  answers: jsonb("answers").notNull().default({}),
  updatedBy: text("updated_by").references(() => users.id),
  updatedAt: updatedAt(),
  version: version(),
});

export const accountHealthSnapshots = pgTable(
  "account_health_snapshots",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    accountId: text("account_id").notNull().references(() => accounts.id),
    score: integer("score"), // null = zu wenig Daten
    coverage: integer("coverage").notNull(), // Datenlage in %
    breakdown: jsonb("breakdown").notNull(),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("account_health_snapshots_account_idx").on(t.accountId)],
);

// ---------------------------------------------------------------------------
// Kundenagenda und SOS-Protokolle (Etappe 26)
// ---------------------------------------------------------------------------

/** Agenda des Kunden: seine Prioritäten, Schlüssel-Initiativen (optional mit Datum) und Herausforderungen. */
export const accountInitiatives = pgTable(
  "account_initiatives",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    accountId: text("account_id").notNull().references(() => accounts.id),
    kind: text("kind").notNull(), // PRIORITAET | INITIATIVE | HERAUSFORDERUNG
    title: text("title").notNull(),
    description: text("description"),
    dueDate: date("due_date"), // z. B. Vertragsende eines Tools, Go-live
    dueHint: text("due_hint"), // Freitext, wenn kein genaues Datum („Ende 2026“)
    status: text("status").notNull().default("OFFEN"), // OFFEN | ERLEDIGT | VERWORFEN
    sourceId: text("source_id").references(() => sources.id),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("account_initiatives_account_idx").on(t.accountId)],
);

/** SOS-Protokoll: auslaufender Einsatz ohne Anschluss, Anker kommt nicht weiter, Lage wird eng. */
export const sosReports = pgTable(
  "sos_reports",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    accountId: text("account_id").notNull().references(() => accounts.id),
    setupId: text("setup_id").references(() => projectSetups.id),
    orderId: text("order_id").references(() => orders.id),
    kind: text("kind").notNull(), // EINSATZ_LAEUFT_AUS | ANKER_BLOCKIERT | LAGE_ENG | SONSTIGES
    title: text("title").notNull(),
    situation: text("situation").notNull(),
    need: text("need"), // Was brauchst du? Wer soll helfen?
    urgency: text("urgency").notNull().default("HOCH"), // HOCH | MITTEL
    status: text("status").notNull().default("OFFEN"), // OFFEN | IN_BEARBEITUNG | GELOEST
    ownerUserId: text("owner_user_id").references(() => users.id), // kümmert sich (i. d. R. BD)
    resolution: text("resolution"),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    version: version(),
  },
  (t) => [index("sos_reports_account_idx").on(t.accountId)],
);

export type Role = (typeof roleEnum.enumValues)[number];
export type PlaybookScope = (typeof playbookScopeEnum.enumValues)[number];
export type PlaybookRunStatus = (typeof playbookRunStatusEnum.enumValues)[number];
export type PlaybookStepStatus = (typeof playbookStepStatusEnum.enumValues)[number];
export type AccessClass = (typeof accessClassEnum.enumValues)[number];
export type SignalStatus = (typeof signalStatusEnum.enumValues)[number];
export type ActionStatus = (typeof actionStatusEnum.enumValues)[number];
export type ActionChannel = (typeof actionChannelEnum.enumValues)[number];
export type HandoverStatus = (typeof handoverStatusEnum.enumValues)[number];
export type SetupStatus = (typeof setupStatusEnum.enumValues)[number];
export type MembershipContribution = (typeof membershipContributionEnum.enumValues)[number];
export type RelationshipState = (typeof relationshipStateEnum.enumValues)[number];
export type AccessStepKind = (typeof accessStepKindEnum.enumValues)[number];
export type AccessPlanStatus = (typeof accessPlanStatusEnum.enumValues)[number];
export type ReviewStatus = (typeof reviewStatusEnum.enumValues)[number];
export type PriorityKind = (typeof priorityKindEnum.enumValues)[number];
export type PriorityStatus = (typeof priorityStatusEnum.enumValues)[number];
export type ArtifactStatus = (typeof artifactStatusEnum.enumValues)[number];
export type ArtifactVariant = (typeof artifactVariantEnum.enumValues)[number];
export type SuggestionStatus = (typeof suggestionStatusEnum.enumValues)[number];
export type PriorityCategory = (typeof priorityCategoryEnum.enumValues)[number];
export type ImportJobStatus = (typeof importJobStatusEnum.enumValues)[number];
export type ImportKind = (typeof importKindEnum.enumValues)[number];
export type SupportRequestStatus = (typeof supportRequestStatusEnum.enumValues)[number];
export type GoalStatus = (typeof goalStatusEnum.enumValues)[number];
export type OpportunityStatus = (typeof opportunityStatusEnum.enumValues)[number];
export type DecisionRole = (typeof decisionRoleEnum.enumValues)[number];
export type OfferStatus = (typeof offerStatusEnum.enumValues)[number];
export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
export type EngagementStatus = (typeof engagementStatusEnum.enumValues)[number];
export type RequirementStatus = (typeof requirementStatusEnum.enumValues)[number];
export type SourceType = (typeof sourceTypeEnum.enumValues)[number];
export type ExtractStatus = (typeof extractStatusEnum.enumValues)[number];
export type IntakeStatus = (typeof intakeStatusEnum.enumValues)[number];
export type InterviewKind = (typeof interviewKindEnum.enumValues)[number];
export type InterviewStatus = (typeof interviewStatusEnum.enumValues)[number];
export type Stance = (typeof stanceEnum.enumValues)[number];
export type AssistantContext = (typeof assistantContextEnum.enumValues)[number];
export type Influence = (typeof influenceEnum.enumValues)[number];
export type ChanceKind = (typeof chanceKindEnum.enumValues)[number];
export type RoleFamily = (typeof roleFamilyEnum.enumValues)[number];
