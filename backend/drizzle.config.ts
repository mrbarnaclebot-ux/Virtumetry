import { defineConfig } from 'drizzle-kit';

// drizzle-kit reads this for `db:generate` (no DB connection needed) and
// `db:migrate` (which does connect using DATABASE_URL).
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/virtspace',
  },
  strict: true,
  verbose: true,
});
