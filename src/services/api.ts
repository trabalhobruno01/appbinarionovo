import type {
  BrasiliaTimeSync,
  ChartAnalysisResult,
  ChatMessage,
  Conversation,
  MarketQuote,
  Project,
  SignalValidationSummary,
  TenantSessionInfo,
  TieRule,
  WalkForwardBacktestResult,
} from '../../shared/types.ts';
import { getFreshIdToken } from './firebase.ts';
import { getClientToken } from './storage.ts';

type UnauthorizedHandler = () => void;
let onUnauthorizedHandler: UnauthorizedHandler | null = null;
const pendingSessionControllers = new Set<AbortController>();

export function registerUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorizedHandler = handler;
}

export function abortPendingApiRequests(): void {
  for (const controller of pendingSessionControllers) {
    try {
      controller.abort();
    } catch {
      // Ignore
    }
  }
  pendingSessionControllers.clear();
}

async function getAuthHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const token = await getFreshIdToken(forceRefresh);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Client-Token': getClientToken(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function parseApiResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Resposta inesperada do servidor.');
  }

  if (!res.ok) {
    const errMsg =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `Erro HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return parsed as T;
}

export async function fetchBrasiliaTime(): Promise<BrasiliaTimeSync> {
  const res = await fetch('/api/time', {
    headers: { 'Content-Type': 'application/json', 'X-Client-Token': getClientToken() },
  });
  return parseApiResponse<BrasiliaTimeSync>(res);
}

const API_TIMEOUT_MS = 45_000;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = API_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  pendingSessionControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Operação cancelada ou tempo limite excedido.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    pendingSessionControllers.delete(controller);
  }
}

async function authenticatedFetch(
  input: RequestInfo | URL,
  init: Omit<RequestInit, 'headers'> = {},
  timeoutMs = API_TIMEOUT_MS,
): Promise<Response> {
  const headers = await getAuthHeaders(false);
  let res = await fetchWithTimeout(input, { ...init, headers }, timeoutMs);

  if (res.status === 401) {
    const freshHeaders = await getAuthHeaders(true);
    if (freshHeaders.Authorization) {
      res = await fetchWithTimeout(input, { ...init, headers: freshHeaders }, timeoutMs);
    }
    if (res.status === 401) {
      onUnauthorizedHandler?.();
    }
  }

  return res;
}

export async function fetchTenantSession(): Promise<TenantSessionInfo> {
  const res = await authenticatedFetch('/api/session', {}, 15_000);
  return parseApiResponse<TenantSessionInfo>(res);
}

export async function fetchRemoteProjects(): Promise<Project[]> {
  const res = await authenticatedFetch('/api/projects', {}, 15_000);
  const data = await parseApiResponse<{ projects?: Project[] }>(res);
  return Array.isArray(data.projects) ? data.projects : [];
}

export async function saveRemoteProject(input: {
  id?: string;
  name: string;
  description?: string;
  defaultAsset?: string | null;
  defaultTimeframe?: string | null;
}): Promise<Project> {
  const res = await authenticatedFetch(
    '/api/projects',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    15_000,
  );
  const data = await parseApiResponse<{ project: Project }>(res);
  return data.project;
}

export async function deleteRemoteProject(id: string): Promise<void> {
  const res = await authenticatedFetch(
    `/api/projects/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    15_000,
  );
  await parseApiResponse<{ ok: boolean }>(res);
}

function compactMessagesForChat(messages: ChatMessage[], userMessage: string): ChatMessage[] {
  const lastAnalysisMsg = [...messages].reverse().find((m) => Boolean(m.analysis));
  const prevAnalysis = lastAnalysisMsg?.analysis;
  const needsVisualReeval =
    !prevAnalysis ||
    prevAnalysis.needsClarification === 'ASSET' ||
    prevAnalysis.needsClarification === 'TIMEFRAME' ||
    /\b(reanalis\w*|ver\s+(a\s+)?(imagem|foto)|olh[ae]\s+(a\s+)?(imagem|foto)|na\s+(imagem|foto))\b/i.test(
      userMessage,
    );

  const lastImageMsgId = needsVisualReeval
    ? [...messages].reverse().find((m) => Boolean(m.imageDataUrl))?.id
    : undefined;

  // Keep only last 4 messages + strip heavy base64 images & raw candle arrays
  return messages.slice(-4).map((m) => ({
    ...m,
    imageDataUrl: m.id === lastImageMsgId ? m.imageDataUrl : undefined,
    marketQuote: undefined,
  }));
}

export async function analyzeChartRequest(payload: {
  imageDataUrl: string;
  userMessage?: string;
  photoReceivedAtBrt?: string;
  history?: ChatMessage[];
  projectId?: string;
  conversationId?: string;
}): Promise<{
  analysis: ChartAnalysisResult;
  marketQuote: MarketQuote | null;
  timeSync: BrasiliaTimeSync;
}> {
  const compactHistory = (payload.history || []).slice(-2).map((m) => ({
    ...m,
    imageDataUrl: undefined,
    marketQuote: undefined,
  }));

  const res = await authenticatedFetch('/api/analyze', {
    method: 'POST',
    body: JSON.stringify({
      ...payload,
      history: compactHistory,
    }),
  });
  return parseApiResponse(res);
}

export async function sendChatFollowUp(payload: {
  messages: ChatMessage[];
  userMessage: string;
  lastAsset?: string | null;
  lastTimeframe?: string | null;
  projectId?: string;
  conversationId?: string;
}): Promise<{
  replyText: string;
  analysis?: ChartAnalysisResult;
  marketQuote: MarketQuote | null;
  timeSync: BrasiliaTimeSync;
}> {
  const res = await authenticatedFetch('/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      ...payload,
      messages: compactMessagesForChat(payload.messages, payload.userMessage),
    }),
  });
  return parseApiResponse(res);
}

export async function fetchRemoteConversations(projectId?: string): Promise<Conversation[]> {
  try {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await authenticatedFetch(`/api/conversations${qs}`, {}, 15_000);
    const data = await parseApiResponse<{ conversations?: Conversation[] }>(res);
    return Array.isArray(data.conversations) ? data.conversations : [];
  } catch {
    return [];
  }
}

export async function saveRemoteConversation(conv: Conversation): Promise<void> {
  try {
    await authenticatedFetch(
      '/api/conversations',
      {
        method: 'POST',
        body: JSON.stringify(conv),
      },
      15_000,
    );
  } catch {
    // IndexedDB remains source of truth if offline
  }
}

export async function deleteRemoteConversation(id: string): Promise<void> {
  try {
    await authenticatedFetch(
      `/api/conversations/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      15_000,
    );
  } catch {
    // Ignore network failures during delete
  }
}

export async function fetchSignalAudit(
  payoutPercent = 80,
  tieRule: TieRule = 'REFUND',
): Promise<SignalValidationSummary> {
  const res = await authenticatedFetch(
    `/api/signals?payout=${encodeURIComponent(payoutPercent)}&tieRule=${encodeURIComponent(tieRule)}`,
    {},
    20_000,
  );
  return parseApiResponse<SignalValidationSummary>(res);
}

export async function settleExpiredSignals(
  payoutPercent = 80,
  tieRule: TieRule = 'REFUND',
): Promise<{ settledNow: number; stillPending: number; summary: SignalValidationSummary }> {
  const res = await authenticatedFetch(
    '/api/signals/settle',
    {
      method: 'POST',
      body: JSON.stringify({ payoutPercent, tieRule }),
    },
    25_000,
  );
  return parseApiResponse(res);
}

export async function runHistoricalBacktest(params: {
  symbol: string;
  timeframe: string;
  expirationBars: number;
  payoutPercent: number;
  tieRule: TieRule;
}): Promise<WalkForwardBacktestResult> {
  const res = await authenticatedFetch(
    '/api/signals/backtest',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
    25_000,
  );
  return parseApiResponse<WalkForwardBacktestResult>(res);
}
