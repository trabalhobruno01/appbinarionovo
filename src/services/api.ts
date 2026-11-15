import type {
  BrasiliaTimeSync,
  ChartAnalysisResult,
  ChatMessage,
  Conversation,
  MarketQuote,
  SignalValidationSummary,
  TieRule,
  WalkForwardBacktestResult,
} from '../../shared/types.ts';
import { getClientToken } from './storage.ts';

function getHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Client-Token': getClientToken(),
  };
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
  const res = await fetch('/api/time', { headers: getHeaders() });
  return parseApiResponse<BrasiliaTimeSync>(res);
}

const API_TIMEOUT_MS = 45_000;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Tempo limite de resposta excedido. Tente novamente.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

  const res = await fetchWithTimeout('/api/analyze', {
    method: 'POST',
    headers: getHeaders(),
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
}): Promise<{
  replyText: string;
  analysis?: ChartAnalysisResult;
  marketQuote: MarketQuote | null;
  timeSync: BrasiliaTimeSync;
}> {
  const res = await fetchWithTimeout('/api/chat', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      ...payload,
      messages: compactMessagesForChat(payload.messages, payload.userMessage),
    }),
  });
  return parseApiResponse(res);
}

export async function fetchRemoteConversations(): Promise<Conversation[]> {
  try {
    const res = await fetch('/api/conversations', { headers: getHeaders() });
    const data = await parseApiResponse<{ conversations?: Conversation[] }>(res);
    return Array.isArray(data.conversations) ? data.conversations : [];
  } catch {
    return [];
  }
}

export async function saveRemoteConversation(conv: Conversation): Promise<void> {
  try {
    await fetch('/api/conversations', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(conv),
    });
  } catch {
    // IndexedDB remains source of truth if offline
  }
}

export async function deleteRemoteConversation(id: string): Promise<void> {
  try {
    await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: getHeaders(),
    });
  } catch {
    // Ignore network failures during delete
  }
}

export async function fetchSignalAudit(
  payoutPercent = 80,
  tieRule: TieRule = 'REFUND',
): Promise<SignalValidationSummary> {
  const res = await fetchWithTimeout(
    `/api/signals?payout=${encodeURIComponent(payoutPercent)}&tieRule=${encodeURIComponent(tieRule)}`,
    { headers: getHeaders() },
    20_000,
  );
  return parseApiResponse<SignalValidationSummary>(res);
}

export async function settleExpiredSignals(
  payoutPercent = 80,
  tieRule: TieRule = 'REFUND',
): Promise<{ settledNow: number; stillPending: number; summary: SignalValidationSummary }> {
  const res = await fetchWithTimeout(
    '/api/signals/settle',
    {
      method: 'POST',
      headers: getHeaders(),
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
  const res = await fetchWithTimeout(
    '/api/signals/backtest',
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(params),
    },
    25_000,
  );
  return parseApiResponse<WalkForwardBacktestResult>(res);
}
