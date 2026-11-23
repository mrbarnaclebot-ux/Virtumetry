import type { FastifyInstance } from 'fastify';

// Liveness probe (spec §7.1). No auth, no DB dependency — must answer 200 even
// when Postgres is unreachable so the platform can distinguish "process up"
// from "database down".
export function healthRoutes(app: FastifyInstance): void {
  app.get('/healthz', async () => ({ status: 'ok' }));
}
