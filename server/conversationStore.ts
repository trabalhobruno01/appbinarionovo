import fs from 'node:fs/promises';
import path from 'node:path';
import type { Conversation } from '../shared/types.ts';

const DATA_DIR = path.resolve(process.cwd(), '.data', 'conversations');

function sanitizeClientId(rawId: string | undefined): string {
  const cleaned = (rawId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned || 'default';
}

async function getClientFile(clientId: string): Promise<string> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  return path.join(DATA_DIR, `${sanitizeClientId(clientId)}.json`);
}

export async function listConversations(clientId: string): Promise<Conversation[]> {
  try {
    const filePath = await getClientFile(clientId);
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Conversation[];
    return Array.isArray(parsed)
      ? parsed.sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso))
      : [];
  } catch {
    return [];
  }
}

export async function saveConversation(clientId: string, conv: Conversation): Promise<Conversation> {
  const filePath = await getClientFile(clientId);
  const existing = await listConversations(clientId);
  const filtered = existing.filter((c) => c.id !== conv.id);
  const updated = [conv, ...filtered].slice(0, 50);
  await fs.writeFile(filePath, JSON.stringify(updated), 'utf-8');
  return conv;
}

export async function deleteConversation(clientId: string, convId: string): Promise<void> {
  const filePath = await getClientFile(clientId);
  const existing = await listConversations(clientId);
  const filtered = existing.filter((c) => c.id !== convId);
  await fs.writeFile(filePath, JSON.stringify(filtered), 'utf-8');
}
