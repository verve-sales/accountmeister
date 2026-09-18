import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

declare global {
  var __vervePool: Pool | undefined;
}

export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL ist nicht gesetzt (siehe .env.example).");
  return url;
}

function createPool(): Pool {
  return new Pool({ connectionString: getDatabaseUrl(), max: 10 });
}

// In der Entwicklung überlebt der Pool Hot-Reloads; sonst pro Prozess genau ein Pool.
const pool = globalThis.__vervePool ?? createPool();
if (process.env.NODE_ENV !== "production") globalThis.__vervePool = pool;

export const db = drizzle(pool, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export { schema };
