// Produktions-Migrationslauf ohne Entwicklungswerkzeuge: nutzt die versionierten SQL-Migrationen aus src/db/migrations.
// Vorher sichern (scripts/backup.sh). Rückfallplan: siehe docs/betrieb.md.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL fehlt"); process.exit(1); }
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle(pool), { migrationsFolder: "src/db/migrations" });
  console.log("Migrationen angewendet.");
} finally {
  await pool.end();
}
