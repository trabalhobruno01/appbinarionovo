import fs from 'node:fs/promises';
import path from 'node:path';
import type { Conversation } from '../../shared/types.ts';

const TMP_DIR = '/tmp/chartpulse-conversations';

function cleanId(raw: string | null): string {
  return (raw || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
}

async function readStore(clientId: string | null): Promise<Conversation[]> {
  try {
    const raw = await fs.readFile(path.join(TMP_DIR, `${cleanId(clientId)}.json`), 'utf-8');
    const parsed = JSON.parse(raw) as Conversation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeStore(clientId: string | null, list: Conversation[]): Promise<void> {
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.writeFile(path.join(TMP_DIR, `${cleanId(clientId)}.json`), JSON.stringify(list), 'utf-8');
}

export default async (req: Request): Promise<Response> => {
  const clientId = req.headers.get('x-client-token');
  const url = new URL(req.url);
  const idParam = url.searchParams.get('id');

  try {
    if (req.method === 'GET') {
      const conversations = await readStore(clientId);
      return Response.json({ conversations });
    }

    if (req.method === 'POST') {
      const conv = (await req.json()) as Conversation;
      if (!conv?.id) {
        return Response.json({ error: 'Conversa inválida.' }, { status: 400 });
      }
      const existing = await readStore(clientId);
      const updated = [conv, ...existing.filter((c) => c.id !== conv.id)].slice(0, 50);
      await writeStore(clientId, updated);
      return Response.json({ conversation: conv });
    }

    if (req.method === 'DELETE') {
      const targetId = idParam || url.pathname.split('/').pop();
      const existing = await readStore(clientId);
      const updated = existing.filter((c) => c.id !== targetId);
      await writeStore(clientId, updated);
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Erro no histórico.' },
      { status: 500 },
    );
  }
};
