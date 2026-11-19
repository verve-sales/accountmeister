import { defaultSpClient, sharePointEnabled, type SpClient } from "./client";
import { LIB, libraryMap } from "./service";

/**
 * e54: Eigene Vertragsvorlage aus SharePoint „Vorlagen › Vertrag“. Word-Dateien (.docx) mit Platzhaltern wie
 * {auftragnehmer_name}. Namen mit „Gesellschaft“ gelten für Gesellschaften, mit „Person“/„Einzel“ für Einzelpersonen;
 * eine einzige Datei ohne diese Wörter gilt für beide. Liegt nichts passendes dort, nimmt der Accountmeister die
 * eingebaute Vorlage.
 */
export async function contractTemplateFromSharePoint(variant: "PERSON" | "GESELLSCHAFT", deps: { client?: SpClient } = {}): Promise<{ name: string; bytes: ArrayBuffer } | null> {
  if (!deps.client && !sharePointEnabled()) return null;
  const client = deps.client ?? (await defaultSpClient());
  const vid = (await libraryMap(client)).get(LIB.VORLAGEN);
  if (!vid) return null;
  const drive = await client.driveOf(vid);
  const files = (await client.children(drive, ["Vertrag"]).catch(() => [])).filter((x) => !x.folder && /\.docx$/i.test(x.name) && !x.name.startsWith("~$"));
  if (!files.length) return null;
  const n = (s: string) => s.toLowerCase();
  const company = files.filter((f) => /gesellschaft|gmbh|firma|unternehmen/.test(n(f.name)));
  const person = files.filter((f) => /person|einzel|freelancer/.test(n(f.name)) && !company.includes(f));
  const neutral = files.filter((f) => !company.includes(f) && !person.includes(f));
  const pick = (variant === "GESELLSCHAFT" ? company[0] : person[0]) ?? (neutral.length === 1 ? neutral[0] : undefined);
  if (!pick) return null;
  return { name: pick.name, bytes: await client.download(drive, pick.id) };
}
