import { analyzeChartImage } from '../../server/aiAnalyst.ts';
import { sanitizeErrorMessage } from '../../server/usageTracker.ts';
import type { ChatMessage } from '../../shared/types.ts';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const body = (await req.json()) as {
      imageDataUrl?: string;
      userMessage?: string;
      photoReceivedAtBrt?: string;
      history?: ChatMessage[];
    };

    if (
      typeof body.imageDataUrl !== 'string' ||
      !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(body.imageDataUrl)
    ) {
      return Response.json(
        { error: 'Formato de imagem inválido. Envie JPEG, PNG ou WebP.' },
        { status: 400 },
      );
    }

    if (new TextEncoder().encode(body.imageDataUrl).length > MAX_IMAGE_BYTES) {
      return Response.json(
        { error: 'Imagem excede o limite permitido após compressão.' },
        { status: 400 },
      );
    }

    const result = await analyzeChartImage({
      imageDataUrl: body.imageDataUrl,
      userMessage: body.userMessage,
      photoReceivedAtBrt: body.photoReceivedAtBrt,
      history: body.history,
    });

    return Response.json(result);
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Erro ao analisar gráfico.';
    const msg = sanitizeErrorMessage(rawMsg);
    const status = msg.includes('GEMINI_API_KEY') ? 503 : msg.includes('429') ? 429 : 500;
    return Response.json({ error: msg }, { status, headers: { 'Cache-Control': 'no-store, private' } });
  }
};
