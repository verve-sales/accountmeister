import "dotenv/config";
import { Pool } from "pg";

/** Setzt die lokale Entwicklungs-/Testdatenbank zurück (nur außerhalb Produktion!). */
async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Reset in Produktion ist gesperrt.");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL fehlt");
  const pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;");
  await pool.end();
  console.log("Datenbank zurückgesetzt. Jetzt: npm run db:migrate && npm run db:seed");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
