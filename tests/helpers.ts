import { db } from "@/db/client";
import { seed, type SeedResult } from "@/db/seed";
import { loadActor, type Actor } from "@/modules/identity/actor";

let seeded: SeedResult | undefined;

export async function ensureSeed(): Promise<SeedResult> {
  if (!seeded) seeded = await seed(db);
  return seeded;
}

export async function actorFor(key: keyof SeedResult["users"]): Promise<Actor> {
  const s = await ensureSeed();
  const actor = await loadActor(s.users[key]);
  if (!actor) throw new Error(`Akteur ${key} nicht ladbar`);
  return actor;
}
