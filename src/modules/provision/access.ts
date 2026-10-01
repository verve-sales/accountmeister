import type { Actor } from "@/modules/identity/actor";

/** Wer den Provisionsrechner nutzt: Anker, BDs, Principals (auch kundenbezogen) sowie der CEO. Principal-Stufen nur für Principals/CEO. */
export function provisionAccess(actor: Actor): { allowed: boolean; principal: boolean } {
  const roles = new Set<string>(actor.roles);
  for (const set of actor.accountRoles.values()) for (const r of set) roles.add(r);
  const principal = roles.has("PRINCIPAL") || roles.has("CEO");
  return { allowed: principal || roles.has("BD") || roles.has("ANKER"), principal };
}
