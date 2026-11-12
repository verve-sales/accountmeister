import { eq } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "@/db/client";

/**
 * „Person bei Kunde“ (e44): So heißt ein Einsatz in Benachrichtigungen, Aufgaben und Hinweisen. Der Einsatztitel ist oft
 * ein Projekt- oder Rollenname aus Moco und sagt nicht, um wen es geht. Ohne Person: „Titel bei Kunde“.
 */
export async function engagementLabel(tx: Tx | Db, e: { title: string; freelancerId: string | null; internalUserId: string | null; accountId: string }): Promise<string> {
  const [person, account] = await Promise.all([
    e.freelancerId
      ? tx.query.freelancers.findFirst({ where: eq(schema.freelancers.id, e.freelancerId), columns: { displayName: true } })
      : e.internalUserId
        ? tx.query.users.findFirst({ where: eq(schema.users.id, e.internalUserId), columns: { displayName: true } })
        : Promise.resolve(undefined),
    tx.query.accounts.findFirst({ where: eq(schema.accounts.id, e.accountId), columns: { name: true } }),
  ]);
  return `${person?.displayName ?? e.title}${account?.name ? ` bei ${account.name}` : ""}`;
}

/** Wie engagementLabel, aber über die Einsatz-ID (für Stellen, die nur die ID kennen). */
export async function engagementLabelById(engagementId: string, tx: Tx | Db = db): Promise<string | null> {
  const e = await tx.query.engagements.findFirst({ where: eq(schema.engagements.id, engagementId), columns: { title: true, freelancerId: true, internalUserId: true, accountId: true } });
  return e ? engagementLabel(tx, e) : null;
}
