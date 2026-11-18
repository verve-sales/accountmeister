import { and, eq, isNull } from "drizzle-orm";
import { db, schema, type Tx } from "@/db/client";

/**
 * Vergleichsschlüssel für Freelancer-Namen: Groß/klein, Umlaute, Titel, Klammerzusätze („(fiktiv)“), Satzzeichen
 * und Reihenfolge („Wagner, Marcel“) spielen keine Rolle.
 */
export function freelancerKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\b(frau|herr|dr|prof|dipl)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/** Automatischer Dublettencheck: bestehender (nicht zusammengeführter) Freelancer mit gleicher Moco-ID, E-Mail oder gleichem Namen. */
export async function findSameFreelancer(tx: Tx | typeof db, workspaceId: string, p: { name: string; email?: string | null; mocoUserId?: number | null }) {
  const all = await tx.query.freelancers.findMany({ where: and(eq(schema.freelancers.workspaceId, workspaceId), isNull(schema.freelancers.mergedIntoId)) });
  const mail = p.email?.trim().toLowerCase();
  const key = freelancerKey(p.name);
  return (
    (p.mocoUserId ? all.find((f) => f.mocoUserId === p.mocoUserId) : undefined) ??
    (mail ? all.find((f) => (f.email ?? "").trim().toLowerCase() === mail) : undefined) ??
    (key ? all.find((f) => freelancerKey(f.displayName) === key) : undefined) ??
    null
  );
}
