import { describe, expect, it } from "vitest";
import cases from "@/modules/ai/evals/structure-note.cases.json";
import { TestProvider } from "@/modules/ai/providers/test";
import { DisabledProvider, AIDisabledError } from "@/modules/ai/providers/disabled";
import { ProductionProvider, ProductionProviderNotApproved } from "@/modules/ai/providers/production";
import { structureNoteOutputSchema } from "@/modules/ai/schemas";
import type { StructureNoteInput } from "@/modules/ai/provider";

type Case = { name: string; input: StructureNoteInput; expect: { types?: string[]; noItemContains?: string[]; hypothesisFor?: string; actionOwner?: string; maxItems?: number; allTypesIn?: string[]; noSuggestionReason?: boolean } };

describe("KI-Anbieter: Evaluationsfälle (Briefing 20.3 – Halluzination, Rollenrespekt, Quellenbindung)", () => {
  const provider = new TestProvider();
  for (const c of cases as Case[]) {
    it(c.name, async () => {
      const raw = await provider.structureNote(c.input);
      const parsed = structureNoteOutputSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      const out = parsed.data!;
      // Quellenbindung: jedes Zitat kommt wörtlich in der Notiz vor
      for (const item of out.items) expect(c.input.noteText).toContain(item.evidenceQuote);
      // Keine erfundenen Namen: nur bekannte Verve-Personen werden zugeordnet
      for (const item of out.items) if (item.proposedOwnerName) expect(c.input.participantNames).toContain(item.proposedOwnerName);
      if (c.expect.types) expect(out.items.map((i) => i.type)).toEqual(c.expect.types);
      if (c.expect.maxItems !== undefined) expect(out.items.length).toBeLessThanOrEqual(c.expect.maxItems);
      if (c.expect.allTypesIn) for (const i of out.items) expect(c.expect.allTypesIn).toContain(i.type);
      if (c.expect.noItemContains) for (const s of c.expect.noItemContains) expect(JSON.stringify(out)).not.toContain(s);
      if (c.expect.hypothesisFor) expect(out.items.some((i) => i.hypothesis === c.expect.hypothesisFor && i.type === "BEOBACHTUNG")).toBe(true);
      if (c.expect.actionOwner) expect(out.items.find((i) => i.type === "AKTION")?.proposedOwnerName).toBe(c.expect.actionOwner);
      if (c.expect.noSuggestionReason) expect(out.noSuggestionReason.length).toBeGreaterThan(0);
    });
  }

  it("Deaktivierter Anbieter und nicht freigegebener Produktivadapter werden ehrlich gemeldet", async () => {
    const input: StructureNoteInput = { noteText: "x", setupName: "x", participantNames: [], knownPersonNames: [], confirmedAssertions: [] };
    expect(new DisabledProvider().info().enabled).toBe(false);
    await expect(new DisabledProvider().structureNote(input)).rejects.toBeInstanceOf(AIDisabledError);
    expect(new ProductionProvider().info().enabled).toBe(false);
    await expect(new ProductionProvider().structureNote(input)).rejects.toBeInstanceOf(ProductionProviderNotApproved);
  });

  it("Schema weist ungültige Ausgaben zurück (fehlendes Zitat, unbekannter Typ)", () => {
    expect(structureNoteOutputSchema.safeParse({ items: [{ type: "BEOBACHTUNG", title: "abc", observation: "abc" }] }).success).toBe(false);
    expect(structureNoteOutputSchema.safeParse({ items: [{ type: "BEDARF_BESTAETIGT", title: "abc", observation: "abc", evidenceQuote: "abc" }] }).success).toBe(false);
    expect(structureNoteOutputSchema.safeParse({ items: [] }).success).toBe(true);
  });
});
