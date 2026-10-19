import { readFileSync } from "node:fs";

/** The part of a voice file the AI sees: everything after the first "---"
 * line. Above it are notes for whoever edits the file. */
export function voiceFromMarkdown(markdown: string): string {
  const parts = markdown.split(/^---\s*$/m);
  const body = (parts.length > 1 ? parts.slice(1).join("---") : markdown).trim();
  if (!body) throw new Error("voice file has nothing after its --- line");
  return body;
}

/** Reads a voice file from the repo's voice/ folder (e.g. "max.md"). Read
 * once at startup, so a missing or empty file fails loudly instead of the
 * bot texting without a voice. vercel.json includes voice/ in the
 * functions. */
export function loadVoice(fileName: string): string {
  return voiceFromMarkdown(readFileSync(new URL(`../voice/${fileName}`, import.meta.url), "utf8"));
}
