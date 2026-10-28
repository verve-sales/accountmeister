import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DomainError, ValidationError } from "@/lib/errors";
import { createAccount, setAccountOrgType } from "@/modules/accounts/service";
import { actorFor, ensureSeed } from "./helpers";

describe("Etappe 41: saubere Stammdaten – Organisationstyp", () => {
  it("S01: Organisationstyp nachtragen – nur mit Schreibrecht, nur gültige Werte", async () => {
    await ensureSeed();
    const david = await actorFor("david");
    const lars = await actorFor("lars");
    const acc = await createAccount(david, { name: `Typlos ${Date.now().toString(36)} (fiktiv)`, orgType: "SONSTIGE", responsibleBdUserId: david.userId });
    await expect(setAccountOrgType(david, acc.id, "")).rejects.toBeInstanceOf(ValidationError);
    await expect(setAccountOrgType(lars, acc.id, "KONZERN")).rejects.toBeInstanceOf(DomainError);
    expect(await setAccountOrgType(david, acc.id, "KONZERN")).toBe("KONZERN");
    expect((await db.query.accounts.findFirst({ where: eq(schema.accounts.id, acc.id) }))!.orgType).toBe("KONZERN");
  });
});
