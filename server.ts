import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { analyzeChartImage, continueChartChat } from './server/aiAnalyst.ts';
import {
  deleteConversation,
  listConversations,
  saveConversation,
} from './server/conversationStore.ts';
import { fetchMarketQuote } from './server/marketData.ts';
import {
  DEFAULT_PAYOUT_PERCENT,
  DEFAULT_TIE_RULE,
  getValidationSummary,
  runCausalWalkForwardBacktest,
  settlePendingSignals,
} from './server/signalValidator.ts';
import { getSynchronizedBrasiliaTime } from './server/timeService.ts';
import { getUsageStats, sanitizeErrorMessage } from './server/usageTracker.ts';
import type { ChatMessage, Conversation, TieRule } from './shared/types.ts';

const PORT = Number(process.env.PORT) || 3000;
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024; // ~5MB limit on payload

// Simple in-flight dedup map to avoid duplicate rapid submissions
const activeRequests = new Map<string, number>();

function checkImageValid(dataUrl: unknown): { ok: boolean; error?: string } {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return { ok: false, error: 'Formato de imagem inválido. Envie PNG, JPEG ou WebP.' };
  }
  const allowed = /^data:image\/(jpeg|jpg|png|webp);base64,/i;
  if (!allowed.test(dataUrl)) {
    return { ok: false, error: 'Tipo de arquivo não suportado. Use JPEG, PNG ou WebP.' };
  }
  if (Buffer.byteLength(dataUrl, 'utf-8') > MAX_IMAGE_BASE64_BYTES) {
    return { ok: false, error: 'Imagem excede o limite de tamanho permitido após compressão.' };
  }
  return { ok: true };
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'chartpulse-ai' });
  });

  app.get('/api/usage', async (_req, res) => {
    try {
      const usage = await getUsageStats();
      res.json(usage);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? sanitizeErrorMessage(err.message) : 'Erro ao consultar consumo.',
      });
    }
  });

  app.get('/api/time', async (_req, res) => {
    try {
      const sync = await getSynchronizedBrasiliaTime(true);
      res.json(sync);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Falha ao sincronizar horário de Brasília.',
      });
    }
  });

  app.get('/api/quote', async (req, res) => {
    try {
      const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : '';
      const timeframe = typeof req.query.timeframe === 'string' ? req.query.timeframe : '15m';
      if (!symbol.trim()) {
        res.status(400).json({ error: 'Parâmetro symbol é obrigatório.' });
        return;
      }
      const quote = await fetchMarketQuote(symbol, timeframe);
      res.json(quote);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Falha ao consultar cotação.',
      });
    }
  });

  app.post('/api/analyze', async (req, res) => {
    const clientToken = req.header('x-client-token') || 'anon';
    const requestKey = `${clientToken}:analyze`;
    const now = Date.now();
    const prevStart = activeRequests.get(requestKey);
    if (prevStart && now - prevStart < 2500) {
      res.status(429).json({ error: 'Análise já em andamento. Aguarde a conclusão.' });
      return;
    }
    activeRequests.set(requestKey, now);

    try {
      const { imageDataUrl, userMessage, photoReceivedAtBrt, history } = req.body as {
        imageDataUrl?: string;
        userMessage?: string;
        photoReceivedAtBrt?: string;
        history?: ChatMessage[];
      };

      const check = checkImageValid(imageDataUrl);
      if (!check.ok) {
        res.status(400).json({ error: check.error });
        return;
      }

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Tempo limite excedido ao analisar o gráfico. Tente novamente.')), 45_000),
      );

      const result = await Promise.race([
        analyzeChartImage({
          imageDataUrl: imageDataUrl!,
          userMessage,
          photoReceivedAtBrt,
          history,
        }),
        timeoutPromise,
      ]);

      res.json(result);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : 'Erro interno ao analisar imagem.';
      const message = sanitizeErrorMessage(rawMsg);
      const status = message.includes('GEMINI_API_KEY')
        ? 503
        : message.includes('429')
          ? 429
          : 500;
      res.status(status).json({ error: message });
    } finally {
      activeRequests.delete(requestKey);
    }
  });

  app.post('/api/chat', async (req, res) => {
    const clientToken = req.header('x-client-token') || 'anon';
    const requestKey = `${clientToken}:chat`;
    const now = Date.now();
    const prevStart = activeRequests.get(requestKey);
    if (prevStart && now - prevStart < 1500) {
      res.status(429).json({ error: 'Solicitação em andamento. Aguarde um instante.' });
      return;
    }
    activeRequests.set(requestKey, now);

    try {
      const { messages, userMessage, lastAsset, lastTimeframe } = req.body as {
        messages?: ChatMessage[];
        userMessage?: string;
        lastAsset?: string | null;
        lastTimeframe?: string | null;
      };

      if (!userMessage || !userMessage.trim()) {
        res.status(400).json({ error: 'Mensagem vazia.' });
        return;
      }

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Tempo limite excedido na resposta da IA.')), 40_000),
      );

      const result = await Promise.race([
        continueChartChat({
          messages: Array.isArray(messages) ? messages : [],
          userMessage: userMessage.trim(),
          lastAsset,
          lastTimeframe,
        }),
        timeoutPromise,
      ]);

      res.json(result);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : 'Erro ao processar conversa.';
      const message = sanitizeErrorMessage(rawMsg);
      const status = message.includes('GEMINI_API_KEY')
        ? 503
        : message.includes('429')
          ? 429
          : 500;
      res.status(status).json({ error: message });
    } finally {
      activeRequests.delete(requestKey);
    }
  });

  app.get('/api/conversations', async (req, res) => {
    try {
      const clientId = req.header('x-client-token') || 'default';
      const list = await listConversations(clientId);
      res.json({ conversations: list });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Erro ao carregar histórico.' });
    }
  });

  app.post('/api/conversations', async (req, res) => {
    try {
      const clientId = req.header('x-client-token') || 'default';
      const conv = req.body as Conversation;
      if (!conv || !conv.id) {
        res.status(400).json({ error: 'Conversa inválida.' });
        return;
      }
      const saved = await saveConversation(clientId, conv);
      res.json({ conversation: saved });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Erro ao salvar conversa.' });
    }
  });

  app.delete('/api/conversations/:id', async (req, res) => {
    try {
      const clientId = req.header('x-client-token') || 'default';
      await deleteConversation(clientId, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Erro ao excluir conversa.' });
    }
  });

  app.get('/api/signals', async (req, res) => {
    try {
      const payout = Number(req.query.payout) || DEFAULT_PAYOUT_PERCENT;
      const tieRule: TieRule = req.query.tieRule === 'LOSS' ? 'LOSS' : DEFAULT_TIE_RULE;
      const settle = req.query.settle !== 'false';
      const summary = await getValidationSummary(payout, tieRule, settle);
      res.json(summary);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? sanitizeErrorMessage(err.message) : 'Erro ao carregar auditoria de sinais.',
      });
    }
  });

  app.post('/api/signals/settle', async (req, res) => {
    try {
      const body = (req.body || {}) as { payoutPercent?: number; tieRule?: TieRule };
      const payout = Number(body.payoutPercent) || DEFAULT_PAYOUT_PERCENT;
      const tieRule: TieRule = body.tieRule === 'LOSS' ? 'LOSS' : DEFAULT_TIE_RULE;
      const settled = await settlePendingSignals(payout, tieRule);
      const summary = await getValidationSummary(payout, tieRule, false);
      res.json({ ...settled, summary });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? sanitizeErrorMessage(err.message) : 'Erro ao liquidar sinais vencidos.',
      });
    }
  });

  app.post('/api/signals/backtest', async (req, res) => {
    try {
      const body = (req.body || {}) as {
        symbol?: string;
        timeframe?: string;
        expirationBars?: number;
        payoutPercent?: number;
        tieRule?: TieRule;
      };
      const symbol = (body.symbol || 'BTCUSDT').trim();
      const result = await runCausalWalkForwardBacktest({
        symbol,
        timeframe: body.timeframe || '15m',
        expirationBars: Number(body.expirationBars) || 1,
        payoutPercent: Number(body.payoutPercent) || DEFAULT_PAYOUT_PERCENT,
        tieRule: body.tieRule === 'LOSS' ? 'LOSS' : DEFAULT_TIE_RULE,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? sanitizeErrorMessage(err.message) : 'Erro ao executar backtest histórico.',
      });
    }
  });

  // Vite middleware in dev, static dist in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ChartPulse AI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
