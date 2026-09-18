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
    setupId: text("setup_id").references(() => projectSetups.id),
    signalId: text("signal_id").references(() => signals.id),
    reviewId: text("review_id").references((): import("drizzle-orm/pg-core").AnyPgColumn => reviews.id), // im Weekly vereinbart
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

export const priorityKindEnum = pgEnum("priority_kind", ["VERLAENGERN", "AUSWEITEN", "VERTIEFEN", "UEBERTRAGEN"]);
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
export const suggestionTypeEnum = pgEnum("suggestion_type", ["BEOBACHTUNG", "AKTION", "ENTSCHEIDUNG", "OFFENE_FRAGE", "PERSON", "KONFLIKT"]);
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
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("ai_jobs_ws_started_idx").on(t.workspaceId, t.startedAt)],
);

export const suggestions = pgTable(
  "suggestions",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    type: suggestionTypeEnum("type").notNull(),
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
export type ReviewStatus = (typeof reviewStatusEnum.enumValues)[number];
export type PriorityKind = (typeof priorityKindEnum.enumValues)[number];
export type PriorityStatus = (typeof priorityStatusEnum.enumValues)[number];
export type ArtifactStatus = (typeof artifactStatusEnum.enumValues)[number];
export type ArtifactVariant = (typeof artifactVariantEnum.enumValues)[number];
export type SuggestionStatus = (typeof suggestionStatusEnum.enumValues)[number];
export type PriorityCategory = (typeof priorityCategoryEnum.enumValues)[number];
