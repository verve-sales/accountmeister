import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "@/db/client";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { hasRoleForAccountWrite } from "@/modules/identity/authz";
import { getAccount } from "./service";

/**
 * Kunden-Kennungen (Etappe 42): Mail-Domänen und Kürzel je Kunde. Trifft eine Kennung, ist die Zuordnung eines
 * Eingangs eindeutig – die KI kann sie nicht überstimmen. Freemail- und eigene Domänen sind nie Kennungen;
 * eine Domäne gehört höchstens einem Kunden.
 */

export const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.de", "hotmail.com", "hotmail.de", "live.com", "live.de", "msn.com",
  "yahoo.com", "yahoo.de", "web.de", "gmx.de", "gmx.net", "gmx.at", "gmx.ch", "t-online.de", "icloud.com", "me.com", "aol.com",
  "posteo.de", "mailbox.org", "freenet.de", "protonmail.com", "proton.me", "arcor.de",
]);

const DOMAIN = /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/;

export function normDomain(v: string): string {
  return v.trim().toLowerCase().replace(/^@/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
}

/** Domäne einer Adresse, wenn sie als Kunden-Kennung taugt (keine Freemail, nicht eigene). */
export function keyDomainOf(email: string, own: Set<string>): string | null {
  const d = normDomain(email.split("@")[1] ?? "");
  if (!d || !DOMAIN.test(d) || FREEMAIL.has(d) || own.has(d) || /(^|\.)verve/.test(d)) return null;
  return d;
}

/** Passt eine Domäne (auch Subdomäne, z. B. de.kunde.com ↔ kunde.com) zu einer Kennung? */
export function domainMatches(domain: string, key: string): boolean {
  return domain === key || domain.endsWith(`.${key}`);
}

export async function ownDomains(tx: Tx | Db, workspaceId: string): Promise<Set<string>> {
  const users = await tx.query.users.findMany({ where: eq(schema.users.workspaceId, workspaceId), columns: { email: true } });
  return new Set(users.map((u) => normDomain(u.email.split("@")[1] ?? "")).filter(Boolean));
}

function canEditKeys(actor: Actor, account: typeof schema.accounts.$inferSelect) {
  return hasRoleForAccountWrite(actor, account) || actor.roles.has("CEO");
}

/** Kennungen setzen (ersetzt die Listen). Kommagetrennt oder Zeilen. */
export async function setAccountKeys(actor: Actor, accountId: string, raw: { domains?: string; aliases?: string }) {
  const account = await getAccount(actor, accountId);
  if (!canEditKeys(actor, account)) throw new ForbiddenError("Kennungen pflegen BD, Principal oder Sales Operations des Kunden.");
  const own = await ownDomains(db, actor.workspaceId);
  const domains = [...new Set((raw.domains ?? "").split(/[,;\s]+/).map(normDomain).filter(Boolean))];
  for (const d of domains) {
    if (!DOMAIN.test(d)) throw new ValidationError(`„${d}“ ist keine Mail-Domäne (Beispiel: kunde.de).`);
    if (FREEMAIL.has(d)) throw new ValidationError(`${d} ist ein Freemail-Anbieter und taugt nicht als Kennung.`);
    if (own.has(d) || /(^|\.)verve/.test(d)) throw new ValidationError(`${d} ist eine eigene Domäne.`);
  }
  if (domains.length) {
    const others = await db.query.accounts.findMany({ where: and(eq(schema.accounts.workspaceId, actor.workspaceId), ne(schema.accounts.id, account.id), sql`${schema.accounts.mailDomains} && ${sql.param(domains)}::text[]`), columns: { name: true, mailDomains: true } });
    if (others.length) {
      const o = others[0]!;
      throw new ConflictError(`${o.mailDomains.find((d) => domains.includes(d))} ist schon Kennung von „${o.name}“.`);
    }
  }
  const aliases = [...new Set((raw.aliases ?? "").split(/[,;\n]+/).map((a) => a.trim()).filter((a) => a.length >= 2).map((a) => a.slice(0, 80)))];
  await db.update(schema.accounts).set({ mailDomains: domains, aliases, updatedAt: new Date() }).where(eq(schema.accounts.id, account.id));
  await recordAudit(db, actor, "account.keys", "ACCOUNT", account.id, { domaenen: domains.length, kuerzel: aliases.length });
  return { domains, aliases };
}

/** Domäne als Kennung lernen, wenn sie noch keinem anderen Kunden gehört. Liefert true, wenn ergänzt. */
export async function learnDomain(tx: Tx | Db, workspaceId: string, accountId: string, domain: string): Promise<boolean> {
  const own = await ownDomains(tx, workspaceId);
  const d = keyDomainOf(`x@${domain}`, own);
  if (!d) return false;
  const holder = await tx.query.accounts.findFirst({ where: and(eq(schema.accounts.workspaceId, workspaceId), sql`${d} = any(${schema.accounts.mailDomains})`), columns: { id: true } });
  if (holder) return false;
  await tx.execute(sql`update accounts set mail_domains = array_append(mail_domains, ${d}) where id = ${accountId} and not (${d} = any(mail_domains))`);
  return true;
}

/** Vorschlag für die Kundenseite: Domänen aus den E-Mail-Adressen bekannter Personen, die noch keine Kennung sind. */
export async function suggestedDomains(accountId: string, workspaceId: string): Promise<string[]> {
  const [people, own, taken] = await Promise.all([
    db.query.persons.findMany({ where: eq(schema.persons.accountId, accountId), columns: { email: true } }),
    ownDomains(db, workspaceId),
    db.query.accounts.findMany({ where: eq(schema.accounts.workspaceId, workspaceId), columns: { mailDomains: true } }),
  ]);
  const used = new Set(taken.flatMap((a) => a.mailDomains));
  return [...new Set(people.map((p) => (p.email ? keyDomainOf(p.email, own) : null)).filter((d): d is string => !!d && !used.has(d)))];
}

/** Konten mit Kennungen für das Routing. */
export async function accountsWithKeys(ids: string[]) {
  if (!ids.length) return [];
  return db.query.accounts.findMany({ where: inArray(schema.accounts.id, ids), columns: { id: true, mailDomains: true, aliases: true } });
}
