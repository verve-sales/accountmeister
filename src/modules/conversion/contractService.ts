import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { requireEngagement } from "@/modules/engagements/authz";
import { addContractDocument } from "@/modules/engagements/service";
import { todayIso } from "@/modules/work/calendar";
import { CONTRACT_TEMPLATE_VERSION, deDate, deMoney, renderContract, type ContractData } from "./contract";

/**
 * Projekteinzelvertrag für den Freelancer eines Einsatzes erzeugen (Etappe 51): Angaben aus Einsatz, Position und
 * Freelancer-Profil, Rest aus dem Formular. Das Ergebnis liegt als Unterlage „Entwurf“ am Einsatz (Seite Verve ↔
 * Freelancer). Erzeugen dürfen BD-Kontext, Sales Operations und die Betreuung des Einsatzes.
 */

export type ContractDefaults = {
  variant: "PERSON" | "GESELLSCHAFT";
  rolle: string;
  leistungsbereich: string;
  aufgaben: string;
  endkunde: string;
  endkundeOrt: string;
  beginn: string;
  ende: string;
  kontingentTage: string;
  stundenJeProjekttag: string;
  bedingungFrist: string;
  einsatzort: string;
  stundensatz: string;
  zahlungszielTage: string;
  kuendigungsfristTage: string;
  ort: string;
  datum: string;
  /** Was im Freelancer-Profil für den Vertrag noch fehlt */
  missingProfile: string[];
  freelancerId: string;
  freelancerName: string;
};

async function load(actor: Actor, engagementId: string) {
  const a = await requireEngagement(actor, engagementId);
  if (!a.manage && !a.care) throw new ForbiddenError("Den Vertrag erzeugen BD, Sales Operations oder die Betreuung des Einsatzes.");
  const e = a.engagement;
  if (!e.freelancerId) throw new ValidationError("Dieser Einsatz ist intern besetzt – ein Freelancer-Vertrag entfällt.");
  const [f, position, period] = await Promise.all([
    db.query.freelancers.findFirst({ where: eq(schema.freelancers.id, e.freelancerId) }),
    db.query.staffingPositions.findFirst({ where: eq(schema.staffingPositions.id, e.positionId) }),
    db.query.engagementPeriods.findFirst({ where: and(eq(schema.engagementPeriods.engagementId, e.id), isNull(schema.engagementPeriods.supersededById)), orderBy: desc(schema.engagementPeriods.validFrom) }),
  ]);
  if (!f) throw new ValidationError("Freelancer nicht gefunden.");
  return { a, e, f, position, period };
}

export async function contractDefaults(actor: Actor, engagementId: string): Promise<ContractDefaults> {
  const { a, e, f, position, period } = await load(actor, engagementId);
  const hours = 8;
  const ek = period?.ek ?? f.ekRate ?? null;
  const unit = period?.ek ? period.rateUnit : f.ekUnit;
  const hourly = ek ? (unit === "TAG" ? Number(ek) / hours : Number(ek)) : null;
  const company = f.legalForm === "GESELLSCHAFT";
  const missing: string[] = [];
  if (!f.street) missing.push("Straße");
  if (!f.postalCity) missing.push("PLZ und Ort");
  if (company && !f.company) missing.push("Firma");
  if (company && !f.representativeName) missing.push("vertretungsberechtigte Person");
  if (company && !f.representativeRole) missing.push("Funktion der vertretungsberechtigten Person");
  if (!company && !f.taxNumber) missing.push("Steuernummer");
  return {
    variant: company ? "GESELLSCHAFT" : "PERSON",
    rolle: position?.title ?? e.title,
    leistungsbereich: "der Software- und Integrationsentwicklung",
    aufgaben: (position?.tasks ?? "").trim(),
    endkunde: a.account.name,
    endkundeOrt: "",
    beginn: e.actualStart ?? e.plannedStart ?? "",
    ende: e.plannedEnd ?? "",
    kontingentTage: "",
    stundenJeProjekttag: String(hours),
    bedingungFrist: e.plannedStart ?? "",
    einsatzort: position?.location ?? "",
    stundensatz: hourly ? hourly.toFixed(2).replace(".", ",") : "",
    zahlungszielTage: String(f.paymentTermDays ?? 30),
    kuendigungsfristTage: "14",
    ort: "Düsseldorf",
    datum: todayIso(),
    missingProfile: missing,
    freelancerId: f.id,
    freelancerName: f.displayName,
  };
}

const d = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum fehlt");
const num = (label: string) => z.string().trim().regex(/^\d{1,4}$/, `${label} bitte als ganze Zahl`);
export const contractInput = z.object({
  rolle: z.string().trim().min(2, "Rolle fehlt").max(200),
  leistungsbereich: z.string().trim().min(3, "Leistungsbereich fehlt").max(300),
  aufgaben: z.string().trim().min(5, "Bitte mindestens eine Aufgabe angeben").max(6000),
  endkunde: z.string().trim().min(2).max(300),
  endkundeOrt: z.string().trim().min(2, "Ort des Endkunden fehlt").max(200),
  beginn: d,
  ende: d,
  kontingentTage: num("Kontingent"),
  stundenJeProjekttag: num("Stunden je Projekttag"),
  bedingungFrist: d,
  einsatzort: z.string().trim().min(2, "Einsatzort fehlt").max(200),
  stundensatz: z.string().trim().regex(/^\d+([.,]\d{1,2})?$/, "Stundensatz bitte als Zahl"),
  zahlungszielTage: num("Zahlungsziel"),
  kuendigungsfristTage: num("Kündigungsfrist"),
  ort: z.string().trim().min(2).max(100),
  datum: d,
});

const fileSafe = (s: string) => s.normalize("NFKD").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60);

export async function generateFreelancerContract(actor: Actor, engagementId: string, raw: unknown, opts: { templateDir?: string } = {}) {
  const p = contractInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => i.message).join("; "));
  const i = p.data;
  if (i.ende < i.beginn) throw new ValidationError("Das Ende liegt vor dem Beginn.");
  const { a, e, f } = await load(actor, engagementId);
  const company = f.legalForm === "GESELLSCHAFT";
  const data: ContractData = {
    variant: company ? "GESELLSCHAFT" : "PERSON",
    rolle: i.rolle,
    leistungsbereich: i.leistungsbereich,
    aufgaben: i.aufgaben.split(/\r?\n/).map((t) => t.replace(/^[-•*]\s*/, "").trim()).filter(Boolean),
    auftragnehmer_name: f.displayName.replace(/\s*\(.*?\)\s*/g, " ").trim(),
    auftragnehmer_firma: f.company ?? undefined,
    auftragnehmer_strasse: f.street ?? "",
    auftragnehmer_plz_ort: f.postalCity ?? "",
    steuernummer: f.taxNumber ?? undefined,
    vertreter_name: f.representativeName ?? undefined,
    vertreter_funktion: f.representativeRole ?? undefined,
    endkunde: i.endkunde,
    endkunde_ort: i.endkundeOrt,
    beginn: deDate(i.beginn),
    ende: deDate(i.ende),
    kontingent_tage: i.kontingentTage,
    stunden_je_projekttag: i.stundenJeProjekttag,
    bedingung_frist: deDate(i.bedingungFrist),
    einsatzort: i.einsatzort,
    stundensatz: deMoney(i.stundensatz),
    zahlungsziel_tage: i.zahlungszielTage,
    kuendigungsfrist_tage: i.kuendigungsfristTage,
    ort: i.ort,
    datum: deDate(i.datum),
  };
  const buf = await renderContract(data, opts);
  const last = f.displayName.replace(/\(.*?\)/g, "").trim().split(/\s+/).pop() ?? "Freelancer";
  const name = `${todayIso()}_Projekteinzelvertrag_${fileSafe(a.account.name)}_${fileSafe(last)}.docx`;
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const file = { name, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: buf.length, arrayBuffer: async () => bytes };
  const { document } = await addContractDocument(actor, e.id, { side: "FREELANCER", docType: "EINZELBEAUFTRAGUNG", title: `Projekteinzelvertrag ${f.displayName} ab ${deDate(i.beginn)}`.slice(0, 200), versionLabel: CONTRACT_TEMPLATE_VERSION, validFrom: i.beginn, validTo: i.ende, signedStatus: "ENTWURF", reviewNote: `Erzeugt aus der Vorlage ${CONTRACT_TEMPLATE_VERSION} (${company ? "Gesellschaft" : "Einzelperson"}).` }, file);
  await recordAudit(db, actor, "contract.generated", "ENGAGEMENT", e.id, { vorlage: CONTRACT_TEMPLATE_VERSION, fassung: data.variant, dokument: document.id });
  return { document, fileName: name };
}
