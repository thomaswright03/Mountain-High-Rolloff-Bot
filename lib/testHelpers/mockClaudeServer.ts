import http from "node:http";
import type { AddressInfo } from "node:net";

/** Minimal fake of the one Anthropic endpoint lib/claude.ts calls
 * (POST /v1/messages), so the code-owned decisions can be tested
 * deterministically: what the model says is scripted per test, so tests
 * check what the code does no matter what the model concludes. Point the SDK at it with
 * ANTHROPIC_BASE_URL before lib/claude.ts creates its client. */
export interface MockClaudeServer {
  url: string;
  /** What the reply-drafting and follow-up calls return. */
  draft: string;
  handoff: boolean;
  /** What the booking extraction returns (lib/rollOffBooking.ts). */
  bookingState: Record<string, unknown>;
  requests: Array<{ system: string; model?: string; cached?: boolean; messages: Array<{ role: string; content: string }> }>;
  close: () => Promise<void>;
}

export function startMockClaudeServer(): Promise<MockClaudeServer> {
  const state = {
    draft: "sounds good :)",
    handoff: false,
    bookingState: { wants_to_book: false, yards: null, customer_type: null, placement: null, call_before_delivery: null } as Record<string, unknown>,
  };
  const requests: MockClaudeServer["requests"] = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `no mock route for ${req.method} ${req.url}` }));
        return;
      }
      const parsed = JSON.parse(body);
      // The bot sends the system prompt as a cacheable text block; accept a plain string too.
      const system: string = typeof parsed.system === "string" ? parsed.system : Array.isArray(parsed.system) ? parsed.system.map((b: { text?: string }) => b.text ?? "").join("\n") : "";
      const cached = Array.isArray(parsed.system) && parsed.system.some((b: { cache_control?: unknown }) => Boolean(b.cache_control));
      requests.push({ system, messages: parsed.messages, model: parsed.model, cached });

      let text: string;
      if (system.includes("hand the") && system.includes("off to a human")) {
        text = JSON.stringify({ handoffToHuman: current().handoff });
      } else if (system.includes("pull roll-off booking details")) {
        text = JSON.stringify(current().bookingState);
      } else {
        text = current().draft;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model: parsed.model,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      );
    });
  });

  let mock: MockClaudeServer;
  const current = () => mock;

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      mock = {
        url: `http://127.0.0.1:${port}`,
        ...state,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      };
      resolve(mock);
    });
  });
}
