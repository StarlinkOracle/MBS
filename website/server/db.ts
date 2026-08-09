import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import pg from 'pg';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const databaseUrl = process.env.DATABASE_URL;
const isLocalDatabaseUrl =
  databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1");
const { Pool: PgPool } = pg;

export const pool = isLocalDatabaseUrl
  ? new PgPool({ connectionString: databaseUrl })
  : new NeonPool({ connectionString: databaseUrl });

export const db = isLocalDatabaseUrl
  ? drizzlePg({ client: pool as PgPool, schema })
  : drizzleNeon({ client: pool as NeonPool, schema });
