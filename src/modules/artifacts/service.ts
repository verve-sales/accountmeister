import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { AccessClass, ArtifactStatus } from "@/db/schema";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canEditSetup, canViewSetup, canViewSource, loadSetupContext, type SetupContext } from "@/modules/identity/authz";
import { ARTIFACT_TEMPLATES, TEMPLATE_REGISTRY_VERSION, getTemplate, type ArtifactTemplate } from "./templates";

/**
 * Artefakte (Briefing 12): Textentwürfe aus registrierten Vorlagen – bearbeitbar, versioniert, mit Quellen und
 * zulässigem Empfängerkreis. Interne Notiz und Kundentext sind getrennte Varianten (12.2): Ein externer
 * Entwurf übernimmt nur Abschnitte, die die Vorlage dafür zulässt, und keine Quellen der Klasse „persönlich“.
 * Kopieren/Exportieren bleibt Nutzerhandlung; es gibt keinen Versand und keinen Vorstellungsstatus (F09).
 */

export type ArtifactContent = Record<string, string>;

export function listTemplates(): ArtifactTemplate[] {
  return ARTIFACT_TEMPLATES;
}

/** Vorlagen, für die im Setup-Kontext ein Textentwurf angelegt werden kann (Datenbezug Setup oder noch nicht modelliert). */
export function templatesForSetupDrafts(): ArtifactTemplate[] {
  return ARTIFACT_TEMPLATES.filter((t) => t.sections.length > 0 && (t.scopeType === "SETUP" || t.implementation === "FOLGT" || t.code === "A5"));
}

export const createDraftInput = z.object({
  templateCode: z.string().min(1),
  setupId: z.string().min(1),
  title: z.string().trim().max(200).optional().or(z.literal("")),
  variant: z.enum(schema.artifactVariantEnum.enumValues).default("INTERN"),
  audience: z.enum(schema.accessClassEnum.enumValues).default("SETUP"),
});

/**
 * Entwurf anlegen: Abschnitte werden aus vorhandenen, berechtigten Daten vorbefüllt (Kontext, Beobachtungen,
 * Aktionen, Entscheidungen). Vorbefüllung ist ein Vorschlag – kein Inhalt gilt als bestätigt.
 */
export async function createDraft(actor: Actor, raw: unknown) {
  const parsed = createDraftInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const template = getTemplate(input.templateCode);
  if (!template || template.sections.length === 0) throw new ValidationError("Für diese Vorlage gibt es keinen Textentwurf; sie ist als Ansicht umgesetzt.");
  if (input.variant === "EXTERN" && !template.externalVariantAllowed) throw new ValidationError("Diese Vorlage sieht keine Kundentext-Variante vor.");
  const ctx = await loadSetupContext(actor, input.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError("Sie dürfen in diesem Setup keine Artefakte entwerfen.");
  if (template.code === "A14" && input.audience !== "PERSOENLICH" && input.audience !== "ACCOUNT_TEAM") {
    throw new ValidationError("Coaching-/Eskalationsnotizen haben einen gesonderten Empfängerkreis (persönlich oder Kundenteam), nie Setup-weit oder Arbeitsraum-weit.");
  }

  const { content, sourceIds } = await prefill(actor, ctx, template, input.variant);
  const artifactKey = crypto.randomUUID();
  return db.transaction(async (tx) => {
    const [v] = await tx
      .insert(schema.artifactVersions)
      .values({
        workspaceId: actor.workspaceId,
        artifactKey,
        versionNo: 1,
        templateCode: template.code,
        templateVersion: TEMPLATE_REGISTRY_VERSION,
        scopeType: "SETUP",
        scopeId: ctx.setup.id,
        setupId: ctx.setup.id,
        accountId: ctx.account.id,
        title: input.title || `${template.name} – ${ctx.setup.name}`,
        variant: input.variant,
        content,
        sourceIds,
        audience: input.audience,
        status: "ENTWURF",
        createdBy: actor.userId,
      })
      .returning();
    if (!v) throw new Error("Entwurf konnte nicht angelegt werden");
    await recordAudit(tx, actor, "artifact.draft_created", "ARTIFACT", artifactKey, { template: template.code, variant: input.variant });
    return v;
  });
}

async function prefill(actor: Actor, ctx: SetupContext, template: ArtifactTemplate, variant: "INTERN" | "EXTERN"): Promise<{ content: ArtifactContent; sourceIds: string[] }> {
  const content: ArtifactContent = {};
  for (const s of template.sections) content[s.key] = "";
  if (variant === "EXTERN") return { content, sourceIds: [] }; // externe Variante startet leer – nur Freigegebenes wird bewusst eingetragen

  const setupId = ctx.setup.id;
  const [signals, actions, decisions, sources] = await Promise.all([
    db.query.signals.findMany({ where: eq(schema.signals.setupId, setupId), orderBy: desc(schema.signals.createdAt) }),
    db.query.actions.findMany({ where: eq(schema.actions.setupId, setupId), orderBy: desc(schema.actions.createdAt) }),
    db.query.decisions.findMany({ where: eq(schema.decisions.setupId, setupId), orderBy: desc(schema.decisions.createdAt) }),
    db.query.sources.findMany({ where: eq(schema.sources.setupId, setupId) }),
  ]);
  const visibleSources = sources.filter((s) => canViewSource(actor, s, ctx));
  const visibleIds = new Set(visibleSources.map((s) => s.id));
  const openSignals = signals.filter((s) => s.status !== "BEENDET" && (!s.sourceId || visibleIds.has(s.sourceId)));
  const openActions = actions.filter((a) => a.status !== "ERLEDIGT" && a.status !== "VERWORFEN");
  const bullet = (xs: string[]) => xs.map((x) => `– ${x}`).join("\n");

  const kontext = [ctx.setup.contextNote ?? "(kein Kontextsatz)", openSignals.length ? `\nOffene Hinweise (Beobachtung, keine bestätigten Bedarfe):\n${bullet(openSignals.map((s) => s.observation))}` : ""].join("\n").trim();
  const grenzen = openSignals.filter((s) => s.usageLimit).map((s) => s.usageLimit as string);
  const aktionen = bullet(openActions.map((a) => `${a.title} (${a.status})`));
  const entscheidungen = bullet(decisions.map((d) => d.content));

  if ("kontext" in content) content.kontext = kontext;
  if ("grenzen" in content) content.grenzen = grenzen.length ? `Nutzungsgrenzen aus Hinweisen:\n${bullet(grenzen)}` : "";
  if ("was_geschah" in content) content.was_geschah = [kontext, aktionen ? `\nAktionen:\n${aktionen}` : "", entscheidungen ? `\nEntscheidungen:\n${entscheidungen}` : ""].join("\n").trim();
  if ("beleg" in content) content.beleg = visibleSources.length ? `Verfügbare Quellen:\n${bullet(visibleSources.map((s) => s.title))}` : "";
  if ("laufzeit" in content) {
    const confirmed = await db.query.assertions.findMany({ where: and(eq(schema.assertions.setupId, setupId), eq(schema.assertions.epistemicStatus, "SACHVERHALT_BESTAETIGT")) });
    content.laufzeit = confirmed.length ? `Bestätigt:\n${bullet(confirmed.map((a) => a.content))}` : "Keine bestätigten Laufzeitangaben.";
  }
  if ("intern" in content) content.intern = grenzen.length ? bullet(grenzen) : "";
  return { content, sourceIds: visibleSources.map((s) => s.id) };
}

export async function requireArtifact(actor: Actor, versionId: string) {
  const v = await db.query.artifactVersions.findFirst({ where: and(eq(schema.artifactVersions.id, versionId), eq(schema.artifactVersions.workspaceId, actor.workspaceId)) });
  if (!v || !v.setupId) throw new NotFoundError("Artefakt");
  const ctx = await loadSetupContext(actor, v.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Artefakt");
  if (!canReadAudience(actor, v.audience, ctx, v.createdBy)) throw new NotFoundError("Artefakt");
  const template = getTemplate(v.templateCode);
  if (!template) throw new NotFoundError("Vorlage");
  return { version: v, ctx, template, canEdit: canEditSetup(actor, ctx) };
}

/** Empfängerkreis des Artefakts (13.5): abgeleitete Inhalte erben die strengste Einschränkung – hier explizit gesetzt. */
function canReadAudience(actor: Actor, audience: AccessClass, ctx: SetupContext, createdBy: string): boolean {
  if (createdBy === actor.userId) return true;
  if (audience === "PERSOENLICH") return false;
  if (audience === "SETUP") return ctx.membership !== null || ctx.setup.bdUserId === actor.userId;
  if (audience === "ACCOUNT_TEAM") return ctx.membership !== null || ctx.setup.bdUserId === actor.userId || ctx.account.responsibleBdUserId === actor.userId || actor.roles.has("PRINCIPAL") || (actor.accountRoles.get(ctx.account.id)?.has("PRINCIPAL") ?? false);
  return true; // WORKSPACE
}

export const saveVersionInput = z.object({
  versionId: z.string().min(1),
  title: z.string().trim().min(3).max(200),
  content: z.record(z.string(), z.string().max(20000)),
  audience: z.enum(schema.accessClassEnum.enumValues).optional(),
  sourceIds: z.array(z.string()).optional(),
});

/** Speichern erzeugt immer eine neue Version (bearbeitbar, versioniert). Freigegebene Versionen bleiben unverändert. */
export async function saveNewVersion(actor: Actor, raw: unknown) {
  const parsed = saveVersionInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { version: prev, template, canEdit } = await requireArtifact(actor, input.versionId);
  if (!canEdit) throw new ForbiddenError();
  const latest = await db.query.artifactVersions.findFirst({ where: eq(schema.artifactVersions.artifactKey, prev.artifactKey), orderBy: desc(schema.artifactVersions.versionNo) });
  if (!latest || latest.id !== prev.id) throw new TransitionError("Es gibt bereits eine neuere Version dieses Artefakts. Bitte von der neuesten Version ausgehen.");
  const content: ArtifactContent = {};
  for (const s of template.sections) {
    const text = (input.content[s.key] ?? "").trim();
    if (prev.variant === "EXTERN" && !s.externalAllowed && text) throw new ValidationError(`Der Abschnitt „${s.label}“ ist in der Kundentext-Variante nicht zulässig.`);
    content[s.key] = text;
  }
  let sourceIds = input.sourceIds ?? prev.sourceIds;
  if (prev.variant === "EXTERN" && sourceIds.length) {
    const srcs = await db.query.sources.findMany({ where: inArray(schema.sources.id, sourceIds) });
    if (srcs.some((s) => s.accessClass === "PERSOENLICH")) throw new ValidationError("Ein Kundentext darf keine persönlichen Quellen referenzieren.");
    sourceIds = srcs.map((s) => s.id);
  }
  return db.transaction(async (tx) => {
    const [v] = await tx
      .insert(schema.artifactVersions)
      .values({
        workspaceId: actor.workspaceId,
        artifactKey: prev.artifactKey,
        versionNo: prev.versionNo + 1,
        templateCode: prev.templateCode,
        templateVersion: prev.templateVersion,
        scopeType: prev.scopeType,
        scopeId: prev.scopeId,
        setupId: prev.setupId,
        accountId: prev.accountId,
        title: input.title,
        variant: prev.variant,
        content,
        sourceIds,
        audience: input.audience ?? prev.audience,
        status: "ENTWURF",
        supersedesId: prev.id,
        createdBy: actor.userId,
      })
      .returning();
    if (!v) throw new Error("Version konnte nicht gespeichert werden");
    if (prev.status === "FREIGEGEBEN") await tx.update(schema.artifactVersions).set({ status: "UEBERHOLT" }).where(eq(schema.artifactVersions.id, prev.id));
    await recordAudit(tx, actor, "artifact.version_saved", "ARTIFACT", prev.artifactKey, { versionNo: v.versionNo });
    return v;
  });
}

const transitions: Record<ArtifactStatus, ArtifactStatus[]> = {
  ENTWURF: ["GEPRUEFT", "FREIGEGEBEN"],
  GEPRUEFT: ["FREIGEGEBEN", "ENTWURF"],
  FREIGEGEBEN: ["UEBERHOLT"],
  UEBERHOLT: [],
};

export const changeStatusInput = z.object({ versionId: z.string().min(1), status: z.enum(schema.artifactStatusEnum.enumValues), confirmNoConfidential: z.union([z.boolean(), z.string()]).optional() });

/**
 * Prüfen / Freigeben. Die Freigabe eines Kundentexts verlangt die ausdrückliche Bestätigung, dass keine
 * vertrauliche Herkunft, interne Bewertung oder nicht freigegebene Projektdetails enthalten sind (12.2).
 * Eine Freigabe ist KEIN Versand und KEIN „tatsächlich vorgestellt“ (9.3 / F09).
 */
export async function changeArtifactStatus(actor: Actor, raw: unknown) {
  const parsed = changeStatusInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { version: v, canEdit, template } = await requireArtifact(actor, input.versionId);
  if (!canEdit) throw new ForbiddenError();
  if (!transitions[v.status].includes(input.status)) throw new TransitionError(`Übergang von „${v.status}“ nach „${input.status}“ ist nicht vorgesehen.`);
  if (input.status === "FREIGEGEBEN") {
    const required = template.sections.filter((s) => s.required && (v.variant === "INTERN" || s.externalAllowed));
    const content = v.content as ArtifactContent;
    const missing = required.filter((s) => !(content[s.key] ?? "").trim());
    if (missing.length) throw new ValidationError(`Vor der Freigabe fehlen Pflichtabschnitte: ${missing.map((m) => m.label).join(", ")}.`);
    const confirmed = input.confirmNoConfidential === true || input.confirmNoConfidential === "true" || input.confirmNoConfidential === "on";
    if (v.variant === "EXTERN" && !confirmed) throw new ValidationError("Bitte bestätigen, dass der Kundentext keine vertrauliche Herkunft, interne Bewertung oder nicht freigegebene Projektdetails enthält.");
  }
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.artifactVersions)
      .set(input.status === "FREIGEGEBEN" ? { status: input.status, approvedBy: actor.userId, approvedAt: new Date() } : { status: input.status })
      .where(eq(schema.artifactVersions.id, v.id))
      .returning();
    await recordAudit(tx, actor, "artifact.status_changed", "ARTIFACT", v.artifactKey, { von: v.status, nach: input.status, versionNo: v.versionNo });
    return updated;
  });
}

/** Artefakte eines Setups: je Kette die neueste Version, gefiltert nach Empfängerkreis. */
export async function listArtifactsForSetup(actor: Actor, setupId: string) {
  const ctx = await loadSetupContext(actor, setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  const rows = await db.query.artifactVersions.findMany({ where: eq(schema.artifactVersions.setupId, setupId), orderBy: desc(schema.artifactVersions.versionNo) });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.artifactKey)) latest.set(r.artifactKey, r);
  const visible = [...latest.values()].filter((r) => canReadAudience(actor, r.audience, ctx, r.createdBy));
  const userIds = [...new Set(visible.flatMap((r) => [r.createdBy, r.approvedBy].filter((x): x is string => !!x)))];
  const users = userIds.length ? await db.query.users.findMany({ where: inArray(schema.users.id, userIds) }) : [];
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  return visible
    .map((r) => ({ ...r, templateName: getTemplate(r.templateCode)?.name ?? r.templateCode, createdByName: un.get(r.createdBy) ?? "?", approvedByName: r.approvedBy ? un.get(r.approvedBy) ?? "?" : null }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function listVersions(actor: Actor, artifactKey: string) {
  const rows = await db.query.artifactVersions.findMany({ where: and(eq(schema.artifactVersions.artifactKey, artifactKey), eq(schema.artifactVersions.workspaceId, actor.workspaceId)), orderBy: desc(schema.artifactVersions.versionNo) });
  return rows;
}
