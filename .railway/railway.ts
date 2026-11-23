import { defineRailway, project, service } from "railway/iac";

// Whole-project file: a resource omitted here is deleted on apply. Both
// services run the same image; SERVICE_ENTRY (a Railway variable) picks
// server vs worker. Variables stay unmanaged so secrets never live here.
export default defineRailway(() => {
  const build = { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" } as const;

  // preDeploy migrate runs on api ONLY (one migrator per release; worker would
  // race the same DDL). PRECONDITION: set MIGRATE_DATABASE_URL on the api
  // service to the DIRECT (non -pooler) Neon host before applying this. Without
  // it migrate.ts falls back to DATABASE_URL, the pgbouncer pooler, where its
  // session advisory lock is unreliable (HANDOFF pooler incident).
  const api = service("api", {
    build,
    preDeploy: "node dist/migrate.js",
    healthcheck: "/healthz",
    replicas: { "us-west2": 1 },
  });
  const worker = service("worker", {
    build,
    replicas: { "us-west2": 1 },
  });

  return project("virtspace", {
    variables: { managed: false },
    resources: [api, worker],
  });
});
