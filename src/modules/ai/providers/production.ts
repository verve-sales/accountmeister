import type { AIProvider, ProviderInfo, StructureNoteInput } from "../provider";
import { DomainError } from "@/lib/errors";

/**
 * Produktivadapter – bewusst nicht aktivierbar, solange Anbieter, Modell, Vertrag, Datenklassen und
 * Datenschutzfreigabe nicht entschieden sind (Briefing 2.3). Der Adapter existiert, damit die Konfiguration
 * eindeutig ist und der Aufrufer nichts „still“ an einen Anbieter sendet.
 */
export class ProductionProviderNotApproved extends DomainError {
  constructor() {
    super("AI_PRODUCTION_NOT_APPROVED", "Der Produktiv-KI-Adapter ist nicht freigegeben (Anbieter-, Modell- und Datenschutzentscheidung offen).", 409);
  }
}

export class ProductionProvider implements AIProvider {
  info(): ProviderInfo {
    return { id: "production", model: "nicht konfiguriert", enabled: false, description: "Produktivadapter vorhanden, aber nicht freigegeben." };
  }
  async structureNote(_input: StructureNoteInput): Promise<unknown> {
    void _input;
    throw new ProductionProviderNotApproved();
  }
}
