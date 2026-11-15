import { continueChartChat } from '../../server/aiAnalyst.ts';
import { sanitizeErrorMessage } from '../../server/usageTracker.ts';
import type { ChatMessage } from '../../shared/types.ts';

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const body = (await req.json()) as {
      messages?: ChatMessage[];
      userMessage?: string;
      lastAsset?: string | null;
      lastTimeframe?: string | null;
    };

    if (!body.userMessage || !body.userMessage.trim()) {
      return Response.json({ error: 'Mensagem vazia.' }, { status: 400 });
    }

    const result = await continueChartChat({
      messages: Array.isArray(body.messages) ? body.messages : [],
      userMessage: body.userMessage.trim(),
      lastAsset: body.lastAsset,
      lastTimeframe: body.lastTimeframe,
    });

    return Response.json(result);
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Erro no chat contextual.';
    const msg = sanitizeErrorMessage(rawMsg);
    const status = msg.includes('GEMINI_API_KEY') ? 503 : msg.includes('429') ? 429 : 500;
    return Response.json({ error: msg }, { status, headers: { 'Cache-Control': 'no-store, private' } });
  }
};
