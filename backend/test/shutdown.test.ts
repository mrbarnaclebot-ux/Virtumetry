import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { installShutdownHandlers } from '../src/server.js';

// Graceful shutdown (spec §10 R10). installShutdownHandlers registers real
// process signal listeners, so each test removes the ones it added; the shutdown
// function it returns is driven directly rather than by raising signals.

afterEach(() => {
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
});

/** A Fastify instance with a slow route we can leave in flight. */
function makeApp(closeImpl?: () => Promise<void>) {
  const app = Fastify({ logger: false });
  if (closeImpl) {
    // Override close() to simulate a drain that never finishes.
    (app as unknown as { close: () => Promise<void> }).close = closeImpl;
  }
  return app;
}

describe('installShutdownHandlers', () => {
  it('closes the app, then exits 0', async () => {
    const app = makeApp();
    const closeSpy = vi.spyOn(app, 'close');
    const exit = vi.fn();

    const shutdown = installShutdownHandlers(app, 5_000, exit);
    shutdown('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('is idempotent — a second signal does not start a second drain', async () => {
    const app = makeApp();
    const closeSpy = vi.spyOn(app, 'close');
    const exit = vi.fn();

    const shutdown = installShutdownHandlers(app, 5_000, exit);
    shutdown('SIGTERM');
    shutdown('SIGTERM');
    shutdown('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it('exits 1 when the drain outruns the grace window', async () => {
    // close() never settles — a wedged keep-alive connection.
    const app = makeApp(() => new Promise<void>(() => undefined));
    const exit = vi.fn();

    const shutdown = installShutdownHandlers(app, 20, exit);
    shutdown('SIGTERM');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 2_000 });
  });

  it('exits 1 when closing throws', async () => {
    const app = makeApp(() => Promise.reject(new Error('close blew up')));
    const exit = vi.fn();

    const shutdown = installShutdownHandlers(app, 5_000, exit);
    shutdown('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('registers SIGTERM and SIGINT listeners', () => {
    const before = {
      term: process.listenerCount('SIGTERM'),
      int: process.listenerCount('SIGINT'),
    };
    installShutdownHandlers(makeApp(), 5_000, vi.fn());
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
  });
});
