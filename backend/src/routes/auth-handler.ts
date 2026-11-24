import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { Auth } from '../auth/better-auth.js';
import type { Config } from '../config.js';

/**
 * Better Auth at /api/auth/* (D-01), bridged Fastify → Fetch.
 *
 * Encapsulated scope with a raw-buffer parser (same pattern as webhooks.ts):
 * the original body bytes go to Better Auth unmodified, and an empty-body POST
 * (sign-out) is not a Fastify JSON 400. The URL is built from BETTER_AUTH_URL,
 * not req.protocol, because the edge terminates TLS.
 */
export async function authHandlerRoutes(
  app: FastifyInstance,
  { auth, config }: { auth: Auth; config: Config },
): Promise<void> {
  await app.register(async (scope) => {
    // No browser origin needs auth yet (web share page comes later).
    await scope.register(cors, { origin: false });
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 64 * 1024 }, (_r, b, done) =>
      done(null, b),
    );
    scope.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      async handler(req, reply) {
        const headers = fromNodeHeaders(req.headers);
        // Overwrites any client-sent value: the rate-limit key is Fastify's
        // hop-trusted req.ip, never raw X-Forwarded-For (D-06).
        headers.set('x-vm-client-ip', req.ip);
        const body = req.body as Buffer | undefined;
        const res = await auth.handler(
          new Request(new URL(req.url, config.BETTER_AUTH_URL), {
            method: req.method,
            headers,
            body: body && body.length ? body : undefined,
          }),
        );
        reply.status(res.status);
        res.headers.forEach((v, k) => {
          if (k !== 'set-cookie') reply.header(k, v);
        });
        // forEach would comma-join multiple cookies into one header.
        const cookies = res.headers.getSetCookie();
        if (cookies.length) reply.header('set-cookie', cookies);
        return reply.send(Buffer.from(await res.arrayBuffer()));
      },
    });
  });
}
