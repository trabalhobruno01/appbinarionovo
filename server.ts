import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { analyzeChartImage, continueChartChat } from './server/aiAnalyst.ts';
import {
  deleteConversation,
  deleteConversationsByProject,
  getConversationById,
  listConversations,
  saveConversation,
} from './server/conversationStore.ts';
import { fetchMarketQuote } from './server/marketData.ts';
import {
  deleteProject,
  ensureAuthorizedProjectForTenant,
  ensureDefaultProject,
  getProjectById,
  listProjects,
  saveProject,
} from './server/projectStore.ts';
import {
  assertSafePayload,
  enforceRateLimitOrThrow,
  getClientIpFromHeaders,
  logSecurityEvent,
  sanitizeSymbolInput,
  SecurityValidationError,
  verifyImageDataUrlMagicBytes,
} from './server/securityGuard.ts';
import {
  DEFAULT_PAYOUT_PERCENT,
  DEFAULT_TIE_RULE,
  getValidationSummary,
  runCausalWalkForwardBacktest,
  settlePendingSignals,
} from './server/signalValidator.ts';
import {
  assertNoTenantSpoofing,
  assertResourceOwnership,
  registerResourceOwnership,
  TenantAccessError,
} from './server/tenantRegistry.ts';
import { getSynchronizedBrasiliaTime } from './server/timeService.ts';
import {
  AuthVerificationError,
  verifyFirebaseIdTokenHeader,
  type VerifiedFirebaseUser,
} from './server/firebaseAuth.ts';
import { getUsageStats, sanitizeErrorMessage } from './server/usageTracker.ts';
import type { ChatMessage, Conversation, TieRule } from './shared/types.ts';

type AuthedRequest = express.Request & { authUser?: VerifiedFirebaseUser };

async function requireFirebaseAuth(
  req: AuthedRequest,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  try {
    const ip = getClientIpFromHeaders((name) => req.header(name), req.ip);
    enforceRateLimitOrThrow({
      key: `api:${ip}`,
      maxRequests: 120,
      windowMs: 60_000,
      route: req.path,
    });

    const user = await verifyFirebaseIdTokenHeader(req.header('authorization'));
    req.authUser = user;
    // Reject any cross-tenant identity spoofing in headers/query immediately
    assertNoTenantSpoofing(
      user,
      [
        req.header('x-company-id'),
        typeof req.query.companyId === 'string' ? req.query.companyId : undefined,
      ],
      'companyId',
    );
    assertNoTenantSpoofing(
      user,
      [
        req.header('x-owner-uid'),
        typeof req.query.ownerUid === 'string' ? req.query.ownerUid : undefined,
        typeof req.query.uid === 'string' ? req.query.uid : undefined,
      ],
      'uid',
    );
    next();
  } catch (err) {
    const status =
      err instanceof AuthVerificationError ||
      err instanceof TenantAccessError ||
      err instanceof SecurityValidationError
        ? err.status
        : 401;
    const message =
      err instanceof AuthVerificationError ||
      err instanceof TenantAccessError ||
      err instanceof SecurityValidationError
        ? err.message
        : 'Autenticação necessária.';
    logSecurityEvent(status === 403 ? 'EXPRESS_FORBIDDEN' : status === 429 ? 'EXPRESS_RATE_LIMIT' : 'EXPRESS_UNAUTHORIZED', {
      path: req.path,
      status,
    });
    res.status(status).json({ error: message });
  }
}

function sendError(res: express.Response, err: unknown, fallbackStatus = 500, fallbackMsg = 'Erro interno.'): void {
  if (
    err instanceof AuthVerificationError ||
    err instanceof TenantAccessError ||
    err instanceof SecurityValidationError
  ) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const msg = err instanceof Error ? sanitizeErrorMessage(err.message) : fallbackMsg;
  res.status(fallbackStatus).json({ error: msg });
}

const PORT = Number(process.env.PORT) || 3000;
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024; // ~5MB limit on payload

// Simple in-flight dedup map scoped per authenticated user UID
const activeRequests = new Map<string, number>();

function checkImageValid(dataUrl: unknown): { ok: boolean; error?: string; status?: number } {
  const result = verifyImageDataUrlMagicBytes(dataUrl, MAX_IMAGE_BASE64_BYTES);
  if (result.ok === false) {
    return { ok: false, error: result.error, status: result.status };
  }
  return { ok: true };
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '6mb' }));
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'status' in err) {
      res.status(400).json({ error: 'JSON inválido na requisição.' });
      return;
    }
    if (typeof err === 'object' && err !== null && 'type' in err && (err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: 'Payload excede o limite permitido.' });
      return;
    }
    next(err);
  });
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self)');
    next();
  });
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, private');
    if (req.method === 'POST' && req.body && typeof req.body === 'object') {
      try {
        assertSafePayload(req.body);
      } catch (err) {
        sendError(res, err, 400, 'Requisição inválida.');
        return;
      }
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'chartpulse-ai' });
  });

  app.get('/api/session', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    try {
      const authUser = req.authUser!;
      await ensureDefaultProject(authUser);
      res.json({
        uid: authUser.uid,
        email: authUser.email,
        companyId: authUser.companyId,
      });
    } catch (err) {
      sendError(res, err, 500, 'Erro ao carregar sessão do usuário.');
    }
  });

  app.get('/api/usage', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    try {
      const authUser = req.authUser!;
      const usage = await getUsageStats({ uid: authUser.uid, companyId: authUser.companyId });
      res.json(usage);
    } catch (err) {
      sendError(res, err, 500, 'Erro ao consultar consumo.');
    }
  });

  app.get('/api/time', async (req, res) => {
    try {
      const ip = getClientIpFromHeaders((name) => req.header(name), req.ip);
      enforceRateLimitOrThrow({
        key: `time:${ip}`,
        maxRequests: 60,
        windowMs: 60_000,
        route: '/api/time',
      });
      const sync = await getSynchronizedBrasiliaTime(true);
      res.json(sync);
    } catch (err) {
      sendError(res, err, 500, 'Falha ao sincronizar horário de Brasília.');
    }
  });

  app.get('/api/quote', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    try {
      const symbol = sanitizeSymbolInput(req.query.symbol, 40);
      const timeframe = sanitizeSymbolInput(req.query.timeframe || '15m', 12) || '15m';
      if (!symbol) {
        res.status(400).json({ error: 'Parâmetro symbol é obrigatório.' });
        return;
      }
      enforceRateLimitOrThrow({
        key: `quote:${req.authUser!.uid}`,
        maxRequests: 60,
        windowMs: 60_000,
        route: '/api/quote',
      });
      const quote = await fetchMarketQuote(symbol, timeframe);
      res.json(quote);
    } catch (err) {
      sendError(res, err, 500, 'Falha ao consultar cotação.');
    }
  });

  app.get('/api/projects', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    try {
      const projects = await listProjects(req.authUser!);
      res.json({ projects });
    } catch (err) {
      sendError(res, err, 500, 'Erro ao carregar projetos.');
    }
  });

  app.get('/api/projects/:id', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    try {
      const project = await getProjectById(req.authUser!, req.params.id);
      res.json({ project });
    } catch (err) {
      sendError(res, err, 500, 'Erro ao carregar projeto.');
    }
  });

  app.post('/api/projects', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    try {
      const authUser = req.authUser!;
      const body = (req.body || {}) as {
        id?: string;
        name?: string;
        description?: string;
        defaultAsset?: string | null;
        defaultTimeframe?: string | null;
        companyId?: string;
        ownerUid?: string;
        uid?: string;
      };
      assertNoTenantSpoofing(authUser, [body.companyId], 'companyId');
      assertNoTenantSpoofing(authUser, [body.ownerUid, body.uid], 'uid');
      const project = await saveProject(authUser, {
        id: body.id,
        name: body.name || '',
        description: body.description,
        defaultAsset: body.defaultAsset,
        defaultTimeframe: body.defaultTimeframe,
      });
      res.json({ project });
    } catch (err) {
      sendError(res, err, 400, 'Erro ao salvar projeto.');
    }
  });

  app.delete('/api/projects/:id', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    try {
      const authUser = req.authUser!;
      await deleteProject(authUser, req.params.id);
      await deleteConversationsByProject(authUser, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, 400, 'Erro ao excluir projeto.');
    }
  });

  app.post('/api/analyze', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    const authUser = req.authUser!;
    const requestKey = `${authUser.companyId}:${authUser.uid}:analyze`;
    const now = Date.now();
    const prevStart = activeRequests.get(requestKey);
    if (prevStart && now - prevStart < 2500) {
      res.status(429).json({ error: 'Análise já em andamento. Aguarde a conclusão.' });
      return;
    }
    activeRequests.set(requestKey, now);

    try {
      const body = req.body as {
        imageDataUrl?: string;
        userMessage?: string;
        photoReceivedAtBrt?: string;
        history?: ChatMessage[];
        projectId?: string;
        conversationId?: string;
        companyId?: string;
        ownerUid?: string;
      };

      enforceRateLimitOrThrow({
        key: `analyze:uid:${authUser.companyId}:${authUser.uid}`,
        maxRequests: 20,
        windowMs: 60_000,
        route: '/api/analyze',
      });

      assertNoTenantSpoofing(authUser, [body.companyId], 'companyId');
      assertNoTenantSpoofing(authUser, [body.ownerUid], 'uid');

      const resolvedProject = await ensureAuthorizedProjectForTenant(authUser, body.projectId);
      if (body.conversationId) {
        await assertResourceOwnership({
          kind: 'conversations',
          resourceId: body.conversationId,
          authUser,
          allowUnregistered: true,
        });
        await registerResourceOwnership({
          kind: 'conversations',
          resourceId: body.conversationId,
          authUser,
          projectId: resolvedProject.id,
        });
      }

      const check = checkImageValid(body.imageDataUrl);
      if (!check.ok) {
        res.status(check.status || 400).json({ error: check.error });
        return;
      }

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Tempo limite excedido ao analisar o gráfico. Tente novamente.')), 45_000),
      );

      const result = await Promise.race([
        analyzeChartImage({
          imageDataUrl: body.imageDataUrl!,
          userMessage: body.userMessage,
          photoReceivedAtBrt: body.photoReceivedAtBrt,
          history: body.history,
          tenant: {
            uid: authUser.uid,
            companyId: authUser.companyId,
            projectId: resolvedProject.id,
            conversationId: body.conversationId,
          },
        }),
        timeoutPromise,
      ]);

      res.json(result);
    } catch (err) {
      if (
        err instanceof AuthVerificationError ||
        err instanceof TenantAccessError ||
        err instanceof SecurityValidationError
      ) {
        res.status(err.status).json({ error: err.message });
        return;
      }
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

  app.post('/api/chat', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    const authUser = req.authUser!;
    const requestKey = `${authUser.companyId}:${authUser.uid}:chat`;
    const now = Date.now();
    const prevStart = activeRequests.get(requestKey);
    if (prevStart && now - prevStart < 1500) {
      res.status(429).json({ error: 'Solicitação em andamento. Aguarde um instante.' });
      return;
    }
    activeRequests.set(requestKey, now);

    try {
      const body = req.body as {
        messages?: ChatMessage[];
        userMessage?: string;
        lastAsset?: string | null;
        lastTimeframe?: string | null;
        projectId?: string;
        conversationId?: string;
        companyId?: string;
        ownerUid?: string;
      };

      enforceRateLimitOrThrow({
        key: `chat:uid:${authUser.companyId}:${authUser.uid}`,
        maxRequests: 35,
        windowMs: 60_000,
        route: '/api/chat',
      });

      assertNoTenantSpoofing(authUser, [body.companyId], 'companyId');
      assertNoTenantSpoofing(authUser, [body.ownerUid], 'uid');

      const resolvedProject = await ensureAuthorizedProjectForTenant(authUser, body.projectId);
      if (body.conversationId) {
        await assertResourceOwnership({
          kind: 'conversations',
          resourceId: body.conversationId,
          authUser,
          allowUnregistered: true,
        });
        await registerResourceOwnership({
          kind: 'conversations',
          resourceId: body.conversationId,
          authUser,
          projectId: resolvedProject.id,
        });
      }

      if (!body.userMessage || !body.userMessage.trim()) {
        res.status(400).json({ error: 'Mensagem vazia.' });
        return;
      }

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Tempo limite excedido na resposta da IA.')), 40_000),
      );

      const result = await Promise.race([
        continueChartChat({
          messages: Array.isArray(body.messages) ? body.messages : [],
          userMessage: body.userMessage.trim(),
          lastAsset: body.lastAsset,
          lastTimeframe: body.lastTimeframe,
          tenant: {
            uid: authUser.uid,
            companyId: authUser.companyId,
            projectId: resolvedProject.id,
            conversationId: body.conversationId,
          },
        }),
        timeoutPromise,
      ]);

      res.json(result);
    } catch (err) {
      if (
        err instanceof AuthVerificationError ||
        err instanceof TenantAccessError ||
        err instanceof SecurityValidationError
      ) {
        res.status(err.status).json({ error: err.message });
        return;
      }
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

  app.get('/api/conversations', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    try {
      const projectId =
        typeof req.query.projectId === 'string' && req.query.projectId.trim()
          ? req.query.projectId.trim()
          : undefined;
      const list = await listConversations(req.authUser!, projectId);
      res.json({ conversations: list });
    } catch (err) {
      sendError(res, err, 500, 'Erro ao carregar histórico.');
    }
  });

  app.get('/api/conversations/:id', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    try {
      const conversation = await getConversationById(req.authUser!, req.params.id);
      res.json({ conversation });
    } catch (err) {
      sendError(res, err, 500, 'Erro ao consultar conversa.');
    }
  });

  app.post('/api/conversations', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    try {
      const authUser = req.authUser!;
      const conv = req.body as Conversation;
      assertNoTenantSpoofing(authUser, [conv?.companyId], 'companyId');
      assertNoTenantSpoofing(authUser, [conv?.ownerUid], 'uid');
      if (!conv || !conv.id) {
        res.status(400).json({ error: 'Conversa inválida.' });
        return;
      }
      const saved = await saveConversation(authUser, conv);
      res.json({ conversation: saved });
    } catch (err) {
      sendError(res, err, 500, 'Erro ao salvar conversa.');
    }
  });

  app.delete('/api/conversations/:id', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    try {
      await deleteConversation(req.authUser!, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, 500, 'Erro ao excluir conversa.');
    }
  });

  app.get('/api/signals', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    try {
      const authUser = req.authUser!;
      const payout = Number(req.query.payout) || DEFAULT_PAYOUT_PERCENT;
      const tieRule: TieRule = req.query.tieRule === 'LOSS' ? 'LOSS' : DEFAULT_TIE_RULE;
      const settle = req.query.settle !== 'false';
      const summary = await getValidationSummary(payout, tieRule, settle, {
        uid: authUser.uid,
        companyId: authUser.companyId,
      });
      res.json(summary);
    } catch (err) {
      sendError(res, err, 500, 'Erro ao carregar auditoria de sinais.');
    }
  });

  app.post('/api/signals/settle', requireFirebaseAuth, async (req: AuthedRequest, res) => {
    try {
      const authUser = req.authUser!;
      const body = (req.body || {}) as { payoutPercent?: number; tieRule?: TieRule };
      const payout = Number(body.payoutPercent) || DEFAULT_PAYOUT_PERCENT;
      const tieRule: TieRule = body.tieRule === 'LOSS' ? 'LOSS' : DEFAULT_TIE_RULE;
      const tenant = { uid: authUser.uid, companyId: authUser.companyId };
      const settled = await settlePendingSignals(payout, tieRule, tenant);
      const summary = await getValidationSummary(payout, tieRule, false, tenant);
      res.json({ ...settled, summary });
    } catch (err) {
      sendError(res, err, 500, 'Erro ao liquidar sinais vencidos.');
    }
  });

  app.post('/api/signals/backtest', requireFirebaseAuth, async (req, res) => {
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

  app.all('/api/*', requireFirebaseAuth, (_req, res) => {
    res.status(404).json({ error: 'Endpoint de API não encontrado.' });
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
