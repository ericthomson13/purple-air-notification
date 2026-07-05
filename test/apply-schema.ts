import { env } from "cloudflare:workers";
import schemaSql from "../schema.sql?raw";

// Setup files run outside per-test-file storage isolation and may run more
// than once; CREATE TABLE/INDEX IF NOT EXISTS in schema.sql make re-running
// this harmless. schema.sql is the single source of truth for the schema -
// no separate migrations directory to keep in sync.
//
// D1's exec() splits input by newline rather than parsing full statements,
// so multi-line CREATE TABLEs break it - split on `;` into whole statements
// and batch them instead.
const statements = schemaSql
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

await env.DB.batch(statements.map((stmt) => env.DB.prepare(stmt)));
