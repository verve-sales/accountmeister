import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getConfig } from "@/lib/config";

/**
 * Verschlüsselung des Refresh-Tokens für Microsoft Graph, bevor er in `integration_connections.token_ref`
 * abgelegt wird (Kommentar dort: „nie der Token selbst“). Es wird kein neues Geheimnis eingeführt – der
 * Schlüssel wird aus dem ohnehin vorhandenen, langen `SESSION_SECRET` abgeleitet (eigener Kontext-Suffix,
 * damit dieselbe Ableitung nicht auch für Sitzungs-Cookies verwendbar ist). AES-256-GCM (authentifiziert).
 */
function derivedKey(): Buffer {
  return createHash("sha256").update(getConfig().SESSION_SECRET + ":graph-refresh-token:v1").digest();
}

export function encryptRefreshToken(refreshToken: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(), iv);
  const enc = Buffer.concat([cipher.update(refreshToken, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

export function decryptRefreshToken(blob: string): string {
  const [version, ivB64, tagB64, encB64] = blob.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !encB64) throw new Error("Ungültiger Token-Speicher.");
  const decipher = createDecipheriv("aes-256-gcm", derivedKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]).toString("utf8");
}
