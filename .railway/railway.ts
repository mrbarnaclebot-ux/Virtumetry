import { defineRailway, project, service } from "railway/iac";

// Whole-project file: a resource omitted here is deleted on apply. Both
// services run the same image; SERVICE_ENTRY (a Railway variable) picks
// server vs worker. Variables stay unmanaged so secrets never live here.
export default defineRailway(() => {
  const build = { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" } as const;

  // preDeploy migrate runs on api ONLY (one migrator per release; worker would
  // race the same DDL). PRECONDITION: MIGRATE_DATABASE_URL on the api service =
  // the DIRECT (non -pooler) Neon host. In production config.ts refuses to boot
  // migrate.ts without it (no fallback to the pooled DATABASE_URL, where the
  // session advisory lock is unreliable).
  const api = service("api", {
    build,
    preDeploy: "node dist/migrate.js",
    healthcheck: "/readyz",
    replicas: { "us-west2": 1 },
  });
  const worker = service("worker", {
    build,
    replicas: { "us-west2": 1 },
  });

  return project("virtumetry", {
    variables: { managed: false },
    resources: [api, worker],
  });
});
