import "dotenv/config";
import { execSync } from "node:child_process";
import { Pool } from "pg";

// Tests laufen ausschließlich gegen die getrennte Testdatenbank.
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL fehlt (siehe .env.example)");
process.env.DATABASE_URL = testUrl;
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.AUTH_MODE = "development";
process.env.SESSION_SECRET ??= "test-session-secret-0123456789abcdef0123456789";

const pool = new Pool({ connectionString: testUrl });
await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;");
await pool.end();
execSync("npx drizzle-kit migrate", { stdio: "pipe", env: { ...process.env, DATABASE_URL: testUrl } });
