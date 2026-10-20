import { createServer } from "node:http";

/** A local kill-switch flag for tests that run with DRY_RUN off, where a
 * missing flag now means paused. Returns the URL; the server never keeps the
 * test process alive. */
export async function startFlagServer(body: unknown = { active: true }, status = 200): Promise<{ url: string; set(body: unknown, status?: number): void }> {
  let current = { body, status };
  const server = createServer((_req, res) => {
    res.writeHead(current.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(current.body));
  });
  server.unref();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/flag.json`,
    set: (b, s = 200) => {
      current = { body: b, status: s };
    },
  };
}
