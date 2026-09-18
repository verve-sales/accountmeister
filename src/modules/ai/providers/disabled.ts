import type { AIProvider, ProviderInfo, StructureNoteInput } from "../provider";
import { DomainError } from "@/lib/errors";

export class AIDisabledError extends DomainError {
  constructor() {
    super("AI_DISABLED", "Der KI-Anbieter ist deaktiviert. Manuelle Dokumentation funktioniert vollständig; Vorschläge werden nicht erzeugt.", 409);
  }
}

export class DisabledProvider implements AIProvider {
  info(): ProviderInfo {
    return { id: "disabled", model: "–", enabled: false, description: "Deaktiviert (Standard). Keine Verarbeitung von Inhalten durch KI." };
  }
  async structureNote(_input: StructureNoteInput): Promise<unknown> {
    void _input;
    throw new AIDisabledError();
  }
}
