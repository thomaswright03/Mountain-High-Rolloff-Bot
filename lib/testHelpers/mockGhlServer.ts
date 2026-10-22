import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockGhlServer {
  url: string;
  sentMessages: Array<{ contactId: string; message: string }>;
  sentEmails: Array<{ contactId: string; subject: string; html: string }>;
  taggedContacts: Array<{ contactId: string; tag: string }>;
  removedTags: Array<{ contactId: string; tag: string }>;
  notes: Array<{ contactId: string; body: string }>;
  starredConversations: string[];
  readConversations: string[];
  /** Every /contacts/upsert body, in order. */
  upserts: Array<Record<string, any>>;
  close: () => Promise<void>;
}

export interface MockGhlFixtures {
  contacts: Record<string, Record<string, any>>;
  conversationHistories: Record<string, Array<{ direction: "inbound" | "outbound"; body: string; dateAdded: string; userId?: string; status?: string }>>;
  /** contactId -> conversationId, for the /conversations/search lookup.
   * Omit a contactId to simulate "no conversation found for this contact". */
  conversationsByContact?: Record<string, string>;
}

/** Minimal fake of the GHL REST endpoints lib/ghl.ts calls, so we can
 * exercise api/webhook.ts's real orchestration logic without hitting the
 * real GoHighLevel API or needing real credentials. */
export function startMockGhlServer(fixtures: MockGhlFixtures): Promise<MockGhlServer> {
  const sentMessages: Array<{ contactId: string; message: string }> = [];
  const sentEmails: Array<{ contactId: string; subject: string; html: string }> = [];
  const taggedContacts: Array<{ contactId: string; tag: string }> = [];
  const removedTags: Array<{ contactId: string; tag: string }> = [];
  const notes: Array<{ contactId: string; body: string }> = [];
  const starredConversations: string[] = [];
  const readConversations: string[] = [];
  const upserts: Array<Record<string, any>> = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      const method = req.method ?? "GET";

      const contactMatch = /^\/contacts\/([^/]+)$/.exec(url);
      if (method === "GET" && contactMatch) {
        const contact = fixtures.contacts[contactMatch[1]!];
        if (!contact) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no such contact fixture" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ contact }));
        return;
      }

      if (method === "GET" && url.startsWith("/conversations/search")) {
        const contactId = new URL(url, "http://localhost").searchParams.get("contactId") ?? "";
        const conversationId = fixtures.conversationsByContact?.[contactId];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ conversations: conversationId ? [{ id: conversationId }] : [], total: conversationId ? 1 : 0 }));
        return;
      }

      if (method === "GET" && url.startsWith("/contacts/search/duplicate")) {
        const email = new URL(url, "http://localhost").searchParams.get("email");
        const id = Object.keys(fixtures.contacts).find((k) => email && fixtures.contacts[k]!.email === email);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ contact: id ? { id, ...fixtures.contacts[id] } : null }));
        return;
      }

      const convoMatch = /^\/conversations\/([^/]+)\/messages$/.exec(url);
      if (method === "GET" && convoMatch) {
        const history = fixtures.conversationHistories[convoMatch[1]!] ?? [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages: history }));
        return;
      }

      const convoUpdateMatch = /^\/conversations\/([^/]+)$/.exec(url);
      if (method === "PUT" && convoUpdateMatch) {
        const parsed = JSON.parse(body);
        if (parsed.starred === true) starredConversations.push(convoUpdateMatch[1]!);
        if (parsed.unreadCount === 0) readConversations.push(convoUpdateMatch[1]!);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, conversation: { id: convoUpdateMatch[1], starred: parsed.starred } }));
        return;
      }

      if (method === "POST" && url === "/conversations/messages") {
        const parsed = JSON.parse(body);
        if (parsed.type === "Email") sentEmails.push({ contactId: parsed.contactId, subject: parsed.subject, html: parsed.html });
        else sentMessages.push({ contactId: parsed.contactId, message: parsed.message });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const tagMatch = /^\/contacts\/([^/]+)\/tags$/.exec(url);
      if (method === "POST" && tagMatch) {
        const parsed = JSON.parse(body);
        for (const tag of parsed.tags ?? []) {
          taggedContacts.push({ contactId: tagMatch[1]!, tag });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (method === "DELETE" && tagMatch) {
        const parsed = JSON.parse(body);
        for (const tag of parsed.tags ?? []) {
          removedTags.push({ contactId: tagMatch[1]!, tag });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const noteMatch = /^\/contacts\/([^/]+)\/notes$/.exec(url);
      if (method === "POST" && noteMatch) {
        const parsed = JSON.parse(body);
        notes.push({ contactId: noteMatch[1]!, body: parsed.body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (method === "GET" && noteMatch) {
        const contactNotes = notes
          .filter((n) => n.contactId === noteMatch[1])
          .map((n, i) => ({ id: `note_${i}`, body: n.body, dateAdded: new Date(Date.now() + i).toISOString() }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ notes: contactNotes }));
        return;
      }

      // Matches an existing fixture contact by phone, like GHL's own
      // duplicate check; otherwise creates one.
      if (method === "POST" && url === "/contacts/upsert") {
        const parsed = JSON.parse(body);
        upserts.push(parsed);
        let id = Object.keys(fixtures.contacts).find(
          (k) => (parsed.phone && fixtures.contacts[k]!.phone === parsed.phone) || (parsed.email && !parsed.phone && fixtures.contacts[k]!.email === parsed.email)
        );
        if (!id) {
          id = `new_${upserts.length}`;
          fixtures.contacts[id] = { tags: [] };
        }
        const { locationId: _loc, ...fields } = parsed;
        Object.assign(fixtures.contacts[id]!, fields);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ new: id.startsWith("new_"), contact: { id, ...fixtures.contacts[id] } }));
        return;
      }

      if (method === "POST" && url === "/contacts/search") {
        const parsed = JSON.parse(body);
        const tagFilter = parsed.filters?.find((f: any) => f.field === "tags")?.value;
        const matches = Object.entries(fixtures.contacts)
          .filter(([, c]) => !tagFilter || (c.tags ?? []).includes(tagFilter))
          .map(([id, c]) => ({ id, ...c }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ contacts: matches, total: matches.length }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `no mock route for ${method} ${url}` }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        sentMessages,
        sentEmails,
        taggedContacts,
        removedTags,
        notes,
        starredConversations,
        readConversations,
        upserts,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
