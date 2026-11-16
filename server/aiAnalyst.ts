import crypto from 'node:crypto';
import { GoogleGenAI, ThinkingLevel, Type, type Content, type Part } from '@google/genai';
import type {
  BrasiliaTimeSync,
  ChartAnalysisResult,
  ChatMessage,
  MarketQuote,
} from '../shared/types.ts';
import { fetchMarketQuote, normalizeAssetQuery } from './marketData.ts';
import { invalidatePendingSignal, recordEmittedSignal } from './signalValidator.ts';
import { formatTimestampBrt, getSynchronizedBrasiliaTime } from './timeService.ts';
import {
  assertNotInRateLimitCooldown,
  GEMINI_MODEL,
  recordCacheHit,
  recordDeduplicatedRequest,
  recordGeminiFailure,
  recordGeminiSuccess,
  recordLatency,
  resolveGeminiApiKey,
  sanitizeErrorMessage,
  type TenantRef,
} from './usageTracker.ts';

export interface AiTenantContext extends TenantRef {
  projectId?: string;
  conversationId?: string;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY não configurada no servidor.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function parseGeminiJsonSafe<T>(rawText: string, fallback: T): T {
  const trimmed = (rawText || '').trim();
  if (!trimmed) return fallback;

  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(withoutFence) as T;
  } catch {
    const firstBrace = withoutFence.indexOf('{');
    const lastBrace = withoutFence.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1)) as T;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

interface StageTimings {
  totalMs: number;
  timeSyncMs: number;
  quoteMs: number;
  geminiMs: number;
}

interface AnalysisBundle {
  analysis: ChartAnalysisResult;
  marketQuote: MarketQuote | null;
  timeSync: BrasiliaTimeSync;
  timings?: StageTimings;
}

// Cache exact image+parameter analyses for 2 minutes to save tokens/RPM
const CACHE_TTL_MS = 120_000;
const CHAT_CACHE_TTL_MS = 30_000;
const analysisCache = new Map<string, { expiresAt: number; result: AnalysisBundle }>();
const inFlightAnalyses = new Map<string, Promise<AnalysisBundle>>();

type ChatBundle = {
  replyText: string;
  analysis?: ChartAnalysisResult;
  marketQuote: MarketQuote | null;
  timeSync: BrasiliaTimeSync;
  timings?: StageTimings;
};
const chatCache = new Map<string, { expiresAt: number; result: ChatBundle }>();
const inFlightChats = new Map<string, Promise<ChatBundle>>();

function computeAnalysisCacheKey(
  imageDataUrl: string,
  userMessage?: string,
  hintAsset?: string | null,
  hintTimeframe?: string | null,
  tenant?: AiTenantContext,
): string {
  return crypto
    .createHash('sha256')
    .update(tenant?.companyId || '_global')
    .update('|')
    .update(tenant?.uid || '_anon')
    .update('|')
    .update(tenant?.projectId || '_proj')
    .update('|')
    .update(tenant?.conversationId || '_conv')
    .update('|')
    .update(imageDataUrl)
    .update('|')
    .update((userMessage || '').trim().toLowerCase())
    .update('|')
    .update((hintAsset || '').trim().toUpperCase())
    .update('|')
    .update((hintTimeframe || '').trim().toLowerCase())
    .digest('hex');
}

// Pure-TS hint extraction so we avoid a second Gemini call whenever user provides asset/timeframe
function extractHintsFromText(
  text?: string,
  fallbackAsset?: string | null,
  fallbackTimeframe?: string | null,
): { assetHint: string | null; timeframeHint: string | null; isOtcHint: boolean } {
  let assetHint: string | null = null;
  let timeframeHint: string | null = null;
  let isOtcHint = false;

  if (text && text.trim()) {
    isOtcHint = /\bOTC\b/i.test(text);
    const tfMatch = text.match(
      /\b(1\s*min(?:uto)?s?|3\s*min(?:uto)?s?|5\s*min(?:uto)?s?|15\s*min(?:uto)?s?|30\s*min(?:uto)?s?|1m|3m|5m|15m|30m|1h|2h|4h|1d|1w|m1|m3|m5|m15|m30|h1|h4|d1)\b/i,
    );
    if (tfMatch) {
      const rawTf = tfMatch[1].toLowerCase().replace(/\s+/g, '');
      if (/^1min/.test(rawTf) || rawTf === 'm1') timeframeHint = '1m';
      else if (/^3min/.test(rawTf) || rawTf === 'm3') timeframeHint = '3m';
      else if (/^5min/.test(rawTf) || rawTf === 'm5') timeframeHint = '5m';
      else if (/^15min/.test(rawTf) || rawTf === 'm15') timeframeHint = '15m';
      else if (/^30min/.test(rawTf) || rawTf === 'm30') timeframeHint = '30m';
      else timeframeHint = rawTf;
    }

    const rawTokens = text
      .replace(/[,.;!?()]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2 && t.length <= 14);

    const stopWords = new Set([
      'COMPRAR', 'COMPRA', 'VENDER', 'VENDA', 'AGUARDAR', 'ANALISAR', 'GRAFICO',
      'GRÁFICO', 'GRAFICOS', 'GRÁFICOS', 'PRECO', 'PREÇO', 'AGORA', 'HOJE', 'TESTE',
      'OLHA', 'ESSE', 'MERCADO', 'MUDOU', 'SINAL', 'VALIDO', 'VÁLIDO', 'CANDLE',
      'CANDLES', 'AINDA', 'POSSO', 'ENTRAR', 'SAIR', 'QUAL', 'RISCO', 'DESSA',
      'SOBRE', 'HORA', 'TEMPO', 'OTC', 'DA', 'DE', 'DO', 'NA', 'NO', 'MIN', 'MINUTO',
      'MINUTOS', 'FOTOGRAFIA', 'FOTO', 'IMAGEM',
    ]);

    for (const rawToken of rawTokens) {
      const upper = rawToken.toUpperCase();
      if (stopWords.has(upper) || /^(1M|3M|5M|15M|30M|1H|2H|4H|1D|1W|M1|M3|M5|M15|M30|H1|H4|D1)$/.test(upper)) {
        continue;
      }
      const norm = normalizeAssetQuery(upper);
      if (!norm) continue;
      // Accept known asset classes directly, or explicit uppercase/numeric tickers (e.g. PETR4, NVDA, BTC/USD)
      const hasDigitOrSymbol = /[0-9/=^.-]/.test(rawToken);
      const isExplicitUppercase = rawToken === upper && /^[A-Z]{2,6}$/.test(rawToken);
      if (norm.market !== 'UNKNOWN' && (norm.market !== 'US_EQUITY' || hasDigitOrSymbol || isExplicitUppercase)) {
        assetHint = isOtcHint && !/\bOTC\b/i.test(upper) ? `${upper} OTC` : upper;
        break;
      }
    }
  }

  const resolvedAsset = assetHint || fallbackAsset || null;
  if (resolvedAsset && /\bOTC\b/i.test(resolvedAsset)) {
    isOtcHint = true;
  }

  return {
    assetHint: resolvedAsset,
    timeframeHint: timeframeHint || fallbackTimeframe || null,
    isOtcHint,
  };
}

interface VisualExtraction {
  isFinancialChart: boolean;
  imageReadable: boolean;
  unreadableReason: string | null;
  asset: string | null;
  isOtc?: boolean;
  timeframe: string | null;
  chartLastPrice: number | null;
}

const VISUAL_EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    isFinancialChart: { type: Type.BOOLEAN },
    imageReadable: { type: Type.BOOLEAN },
    unreadableReason: { type: Type.STRING, nullable: true },
    asset: { type: Type.STRING, nullable: true },
    isOtc: { type: Type.BOOLEAN, nullable: true },
    timeframe: { type: Type.STRING, nullable: true },
    chartLastPrice: { type: Type.NUMBER, nullable: true },
  },
  required: ['isFinancialChart', 'imageReadable'],
};

export const MIN_CONFIDENCE_THRESHOLD = 65;
export const MAX_CONFIDENCE_CAP = 88;
export const CONFIDENCE_DISCLAIMER =
  'Estimativa técnica baseada nos critérios visíveis do gráfico (limite mínimo de 65%); não representa probabilidade estatística calibrada de vitória e a diferença percentual não equivale à chance de perda.';

const FINAL_DECISION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    decision: {
      type: Type.STRING,
      description: 'COMPRA (para CALL/subida), VENDA (para PUT/queda), AGUARDAR ou SINAL_EXPIRADO',
    },
    expectedDirection: {
      type: Type.STRING,
      description: 'SUBIDA (obrigatório se COMPRA), QUEDA (obrigatório se VENDA) ou INDEFINIDA (se AGUARDAR/EXPIRADO)',
    },
    buyConfidencePct: {
      type: Type.NUMBER,
      description: 'Estimativa conservadora de confiança técnica para COMPRA (CALL), inteiro de 0 a 88 (nunca usar 95, 99 ou 100)',
    },
    sellConfidencePct: {
      type: Type.NUMBER,
      description: 'Estimativa conservadora de confiança técnica para VENDA (PUT), inteiro de 0 a 88 (nunca usar 95, 99 ou 100)',
    },
    bestDirection: {
      type: Type.STRING,
      description: 'Direção com melhores evidências técnicas: COMPRA, VENDA ou INDEFINIDA',
    },
    marketRegime: {
      type: Type.STRING,
      description: 'Regime predominante observado na foto: TENDENCIA_ALTA, TENDENCIA_BAIXA, LATERAL, REVERSAO ou INDETERMINADO',
    },
    lateEntryDetected: {
      type: Type.BOOLEAN,
      description: 'true se o preço já percorreu grande parte do movimento ou a entrada estiver atrasada/esticada',
    },
    analysisQuality: {
      type: Type.STRING,
      description: 'Classificação da qualidade técnica da oportunidade: FORTE, MODERADA ou INSUFICIENTE',
    },
    waitCategory: {
      type: Type.STRING,
      nullable: true,
      description: 'Obrigatório quando decision=AGUARDAR: IMAGEM_ILEGIVEL, MERCADO_LATERAL, SINAIS_CONTRADITORIOS ou AGUARDAR_CONFIRMACAO. Use null se COMPRA/VENDA.',
    },
    expired: { type: Type.BOOLEAN },
    asset: { type: Type.STRING, nullable: true },
    timeframe: { type: Type.STRING, nullable: true },
    entryWindowBrt: { type: Type.STRING, nullable: true, description: 'Horário futuro de entrada em HH:MM BRT calculado a partir do relógio oficial de Brasília' },
    expirationDuration: { type: Type.STRING, nullable: true, description: 'Tempo de expiração compatível (em M1 considere 1 min, 2 min, 3 min ou 5 min conforme estrutura e corretora)' },
    expirationOptionsM1: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Quando timeframe for M1, opcoes possiveis de expiracao compativeis (ex: ["1 min", "2 min", "3 min", "5 min"])',
    },
    exitWindowBrt: { type: Type.STRING, nullable: true, description: 'Horário de vencimento em HH:MM BRT estritamente posterior à entrada' },
    timeRemainingToEntry: { type: Type.STRING, nullable: true },
    signalValidity: { type: Type.STRING, nullable: true },
    entryPrice: { type: Type.STRING, nullable: true },
    targetPrice: { type: Type.STRING, nullable: true },
    stopLoss: { type: Type.STRING, nullable: true },
    technicalConfidence: { type: Type.NUMBER, nullable: true },
    reason: { type: Type.STRING, description: 'JUSTIFICATIVA técnica objetiva analisando todos os candles visíveis (corpos, pavios, tendência, S/R, rompimentos/falsos rompimentos, retestes, pullbacks, rejeições, padrões e momentum)' },
    riskWarning: { type: Type.STRING, nullable: true, description: 'RISCO: evidências contrárias e o que pode invalidar a operação' },
    favorableEvidences: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Evidências técnicas objetivas a favor da melhor direção',
    },
    contraryEvidences: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Evidências contrárias, riscos de exaustão ou pontos de atenção no gráfico',
    },
    entryTrigger: {
      type: Type.STRING,
      nullable: true,
      description: 'Quando AGUARDAR, descreva exatamente o que falta acontecer no gráfico para justificar uma entrada',
    },
    entryCondition: { type: Type.STRING, nullable: true },
    cancellationCondition: { type: Type.STRING, nullable: true },
    nextAction: { type: Type.STRING, nullable: true },
    needsClarification: {
      type: Type.STRING,
      nullable: true,
      description: 'ASSET, TIMEFRAME, NEW_PHOTO ou null',
    },
    clarificationQuestion: { type: Type.STRING, nullable: true },
    visibleIndicators: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: [
    'decision',
    'expectedDirection',
    'buyConfidencePct',
    'sellConfidencePct',
    'bestDirection',
    'marketRegime',
    'lateEntryDetected',
    'analysisQuality',
    'expired',
    'reason',
    'riskWarning',
    'favorableEvidences',
    'contraryEvidences',
    'visibleIndicators',
  ],
};

function parseBase64Image(dataUrlOrBase64: string, fallbackMime = 'image/jpeg'): { mimeType: string; data: string } {
  const match = dataUrlOrBase64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (match) {
    return { mimeType: match[1], data: match[2] };
  }
  return { mimeType: fallbackMime, data: dataUrlOrBase64 };
}

export type LegacyAwareChatEntry = Partial<ChatMessage> & {
  role?: string;
  parts?: Part[];
  content?: string;
  functionCall?: Part['functionCall'];
  functionResponse?: Part['functionResponse'];
};

function isValidGeminiPart(part: unknown): part is Part {
  if (!part || typeof part !== 'object') return false;
  const p = part as Record<string, unknown>;
  if (typeof p.text === 'string') return p.text.trim().length > 0;
  if (p.inlineData && typeof p.inlineData === 'object') return true;
  if (p.fileData && typeof p.fileData === 'object') return true;
  if (p.functionCall && typeof p.functionCall === 'object') return true;
  if (p.functionResponse && typeof p.functionResponse === 'object') return true;
  return false;
}

export function validateGeminiContents(contents: Content[]): Content[] {
  if (!Array.isArray(contents) || contents.length === 0) {
    const msg = '[ChartPulse][Gemini] Payload inválido: contents vazio antes da chamada à API.';
    console.error(sanitizeErrorMessage(msg));
    throw new Error('Histórico inválido para envio ao modelo Gemini.');
  }

  for (let i = 0; i < contents.length; i += 1) {
    const entry = contents[i];
    if (!entry || (entry.role !== 'user' && entry.role !== 'model')) {
      const safeRole = sanitizeErrorMessage(String(entry?.role ?? 'undefined'));
      console.error(`[ChartPulse][Gemini] Role inválido bloqueado antes da chamada (índice ${i}): ${safeRole}`);
      throw new Error(`Role inválido detectado antes do envio ao Gemini (${safeRole}).`);
    }

    if (!Array.isArray(entry.parts) || entry.parts.length === 0) {
      console.error(`[ChartPulse][Gemini] Mensagem sem parts válidos bloqueada (índice ${i}, role ${entry.role}).`);
      throw new Error('Mensagem sem conteúdo válido para envio ao Gemini.');
    }

    for (const part of entry.parts) {
      if (!isValidGeminiPart(part)) {
        console.error(`[ChartPulse][Gemini] Part inválido bloqueado (índice ${i}, role ${entry.role}).`);
        throw new Error('Parte de mensagem inválida para envio ao Gemini.');
      }
      if ('functionCall' in part && part.functionCall && entry.role !== 'model') {
        console.error(`[ChartPulse][Gemini] functionCall exige role="model" (índice ${i}).`);
        throw new Error('Chamada de ferramenta com role incompatível.');
      }
      if ('functionResponse' in part && part.functionResponse && entry.role !== 'user') {
        console.error(`[ChartPulse][Gemini] functionResponse exige role="user" (índice ${i}).`);
        throw new Error('Resposta de ferramenta com role incompatível.');
      }
    }
  }

  if (contents[contents.length - 1]?.role !== 'user') {
    console.error('[ChartPulse][Gemini] Última mensagem do payload precisa ter role="user".');
    throw new Error('Sequência de conversa inválida: última mensagem deve ser do usuário.');
  }

  return contents;
}

export function buildGeminiContentsFromHistory(params: {
  messages: LegacyAwareChatEntry[];
  currentUserParts: Part[];
  maxHistoryTurns?: number;
}): { contents: Content[]; extraSystemInstructions: string[] } {
  const maxTurns = params.maxHistoryTurns ?? 4;
  const extraSystemInstructions: string[] = [];
  const normalizedHistory: Content[] = [];

  const recentEntries = Array.isArray(params.messages)
    ? params.messages.slice(-Math.max(maxTurns * 2, maxTurns))
    : [];

  for (const item of recentEntries) {
    if (!item || typeof item !== 'object') continue;
    if (item.error === true) continue;

    const rawRole = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
    const rawText =
      typeof item.text === 'string'
        ? item.text.trim()
        : typeof item.content === 'string'
          ? item.content.trim()
          : '';

    // System/developer messages must never enter contents[] — move to systemInstruction
    if (rawRole === 'system' || rawRole === 'developer') {
      if (rawText) {
        extraSystemInstructions.push(rawText.slice(0, 400));
      }
      continue;
    }

    const parts: Part[] = [];
    if (Array.isArray(item.parts) && item.parts.length > 0) {
      for (const p of item.parts) {
        if (isValidGeminiPart(p)) {
          parts.push(p);
        }
      }
    } else {
      if (item.functionCall && typeof item.functionCall === 'object') {
        parts.push({ functionCall: item.functionCall });
      }
      if (item.functionResponse && typeof item.functionResponse === 'object') {
        parts.push({ functionResponse: item.functionResponse });
      }
      if (rawText) {
        parts.push({ text: rawText.slice(0, 600) });
      }
    }

    if (parts.length === 0) continue;

    let mappedRole: 'user' | 'model' | null = null;
    if (rawRole === 'user') {
      mappedRole = 'user';
    } else if (rawRole === 'assistant' || rawRole === 'model') {
      mappedRole = 'model';
    } else if (
      (rawRole === 'tool' || rawRole === 'function') &&
      parts.some((p) => 'functionResponse' in p && Boolean(p.functionResponse))
    ) {
      mappedRole = 'user';
    } else {
      console.warn(
        `[ChartPulse][Gemini] Registro histórico ignorado por role incompatível: ${sanitizeErrorMessage(rawRole || 'ausente')}`,
      );
      continue;
    }

    const hasFnCall = parts.some((p) => 'functionCall' in p && Boolean(p.functionCall));
    const hasFnResp = parts.some((p) => 'functionResponse' in p && Boolean(p.functionResponse));
    if ((hasFnCall && mappedRole !== 'model') || (hasFnResp && mappedRole !== 'user')) {
      console.warn(
        `[ChartPulse][Gemini] Registro de ferramenta ignorado por inconsistência entre part e role (${mappedRole}).`,
      );
      continue;
    }

    const prev = normalizedHistory[normalizedHistory.length - 1];
    if (prev && prev.role === mappedRole && prev.parts) {
      prev.parts.push(...parts);
    } else {
      normalizedHistory.push({ role: mappedRole, parts });
    }
  }

  // Keep only the most recent maxTurns while ensuring conversation starts with a 'user' turn
  let boundedHistory = normalizedHistory.slice(-maxTurns);
  while (boundedHistory.length > 0 && boundedHistory[0]?.role !== 'user') {
    boundedHistory = boundedHistory.slice(1);
  }

  const validCurrentParts = params.currentUserParts.filter((p) => isValidGeminiPart(p));
  const lastTurn = boundedHistory[boundedHistory.length - 1];
  if (lastTurn && lastTurn.role === 'user' && lastTurn.parts) {
    lastTurn.parts.push(...validCurrentParts);
  } else {
    boundedHistory.push({ role: 'user', parts: validCurrentParts });
  }

  return {
    contents: boundedHistory,
    extraSystemInstructions,
  };
}

function formatQuoteContext(
  quote: MarketQuote | null,
  chartLastPrice: number | null,
  isOtc = false,
): {
  freshnessStatus: ChartAnalysisResult['dataFreshnessStatus'];
  freshnessNote: string;
  contextText: string;
} {
  if (!quote || !quote.available) {
    return {
      freshnessStatus: 'SEM_COTACAO_TEMPO_REAL',
      freshnessNote: isOtc
        ? 'Ativo OTC da corretora (preço sintético próprio): análise baseada nos candles visíveis da fotografia.'
        : quote?.warning || 'Cotação externa indisponível; análise baseada diretamente nos candles visíveis.',
      contextText: isOtc
        ? 'ATIVO OTC DA CORRETORA: mercado OTC possui cotação sintética própria e não depende de feed externo. Analise normalmente os candles da fotografia sem recusar por falta de cotação externa.'
        : (quote?.warning || 'SEM COTAÇÃO AO VIVO EXTERNA. Analise os candles visíveis da fotografia normalmente, indicando que a leitura é puramente gráfica.'),
    };
  }

  let freshnessStatus: ChartAnalysisResult['dataFreshnessStatus'] = 'ATUALIZADO';
  let diffNote = '';

  if (isOtc) {
    diffNote = `Ativo OTC: referência spot externa ${quote.price} ${quote.currency} (corretoras OTC possuem precificação própria e NÃO precisam coincidir com o preço spot; avalie os candles da imagem normalmente sem marcar SINAL_EXPIRADO por diferença OTC).`;
  } else if (chartLastPrice !== null && Number.isFinite(chartLastPrice) && quote.price > 0) {
    const pctDiff = ((quote.price - chartLastPrice) / chartLastPrice) * 100;
    if (Math.abs(pctDiff) >= 0.8) {
      freshnessStatus = 'DEFASADO';
      diffNote = `OBSERVAÇÃO: Preço visível na foto (${chartLastPrice}) difere em ${pctDiff >= 0 ? '+' : ''}${pctDiff.toFixed(2)}% da cotação spot (${quote.price} ${quote.currency}). Considere se houve movimentação ou spread/OTC da corretora antes de invalidar o setup.`;
    } else {
      diffNote = `Foto (${chartLastPrice}) alinhada à cotação atual (${quote.price} ${quote.currency}).`;
    }
  } else {
    diffNote = `Cotação ao vivo (${quote.provider}): ${quote.price} ${quote.currency}.`;
  }

  const recentCandles = quote.candles.slice(-24);
  let windowSummary = '';
  if (recentCandles.length >= 4) {
    const minLow = Math.min(...recentCandles.map((c) => c.low));
    const maxHigh = Math.max(...recentCandles.map((c) => c.high));
    const firstOpen = recentCandles[0].open;
    const lastClose = recentCandles[recentCandles.length - 1].close;
    const bias = lastClose > firstOpen ? 'ALTISTA' : lastClose < firstOpen ? 'BAIXISTA' : 'NEUTRO';
    windowSummary = `CONTEXTO ${recentCandles.length} CANDLES (${quote.timeframe}): mín ${minLow} | máx ${maxHigh} | viés ${bias}`;
  }

  const candlesSummary = recentCandles
    .slice(-8)
    .map((c) => `[${c.timeBrt} A:${c.open} M:${c.high} m:${c.low} F:${c.close}]`)
    .join(' ');

  const contextText = [
    `ATIVO: ${quote.displayName} (${quote.symbol}) | PROVEDOR: ${quote.provider}`,
    `PREÇO ATUAL: ${quote.price} ${quote.currency} (${quote.fetchedAtBrt} BRT)${quote.changePercent24h !== null ? ` | VAR: ${quote.changePercent24h}%` : ''}`,
    diffNote,
    windowSummary || null,
    candlesSummary ? `ÚLTIMOS CANDLES (${quote.timeframe}): ${candlesSummary}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    freshnessStatus,
    freshnessNote: diffNote + (quote.warning ? ` ${quote.warning}` : ''),
    contextText,
  };
}

function parseDurationMinutes(durationText?: string | null, timeframe?: string | null): number {
  const src = (durationText || timeframe || '1m').toLowerCase().trim();
  const minMatch = src.match(/(\d+)\s*(?:min|m\b)/);
  if (minMatch) return Math.max(1, Math.min(240, Number(minMatch[1])));
  const hourMatch = src.match(/(\d+)\s*(?:h|hora)/);
  if (hourMatch) return Math.max(60, Math.min(1440, Number(hourMatch[1]) * 60));
  if (/^m(\d+)$/.test(src)) return Math.max(1, Number(src.slice(1)));
  return /^(1m|m1|1\s*min)/.test(src) ? 1 : 5;
}

function parseMinutesOfDay(hhmm?: string | null): number | null {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const match = hhmm.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(mins) || hours < 0 || hours > 23 || mins < 0 || mins > 59) {
    return null;
  }
  return hours * 60 + mins;
}

function formatMinutesToBrt(totalMinutes: number): string {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return `${hh}:${mm} BRT`;
}

function normalizeDecisionValue(raw?: string | null): ChartAnalysisResult['decision'] {
  const up = (raw || '').toUpperCase().trim();
  if (up.includes('EXPIRAD') || up.includes('EXPIRED')) return 'SINAL_EXPIRADO';
  if (up === 'COMPRA' || up === 'CALL' || up.includes('COMPRA') || up.includes('BUY')) return 'COMPRA';
  if (up === 'VENDA' || up === 'PUT' || up.includes('VENDA') || up.includes('SELL')) return 'VENDA';
  return 'AGUARDAR';
}

function normalizeExpectedDirection(raw?: string | null): 'SUBIDA' | 'QUEDA' | 'INDEFINIDA' {
  const up = (raw || '').toUpperCase().trim();
  if (up.includes('SUBID') || up.includes('ALTA') || up === 'UP' || up === 'CALL') return 'SUBIDA';
  if (up.includes('QUED') || up.includes('BAIXA') || up === 'DOWN' || up === 'PUT') return 'QUEDA';
  return 'INDEFINIDA';
}

function normalizeAnalysisQuality(
  raw?: string | null,
  decision?: ChartAnalysisResult['decision'],
): 'FORTE' | 'MODERADA' | 'INSUFICIENTE' {
  const up = (raw || '').toUpperCase().trim();
  if (up.includes('FORT') || up.includes('STRONG') || up.includes('ALT')) return 'FORTE';
  if (up.includes('MOD')) return 'MODERADA';
  if (up.includes('INSUF') || up.includes('FRAC') || up.includes('WEAK')) return 'INSUFICIENTE';
  return decision === 'COMPRA' || decision === 'VENDA' ? 'MODERADA' : 'INSUFICIENTE';
}

function normalizeWaitCategory(
  raw?: string | null,
  decision?: ChartAnalysisResult['decision'],
): ChartAnalysisResult['waitCategory'] {
  if (decision === 'COMPRA' || decision === 'VENDA' || decision === 'SINAL_EXPIRADO') return null;
  const up = (raw || '').toUpperCase().trim();
  if (up.includes('ILEG') || up.includes('BLUR') || up.includes('SEM_LEIT')) return 'IMAGEM_ILEGIVEL';
  if (up.includes('LATERAL') || up.includes('CONSOLID') || up.includes('RANGE')) return 'MERCADO_LATERAL';
  if (up.includes('CONTRAD')) return 'SINAIS_CONTRADITORIOS';
  if (up.includes('CONFIRM') || up.includes('GATILH')) return 'AGUARDAR_CONFIRMACAO';
  return 'AGUARDAR_CONFIRMACAO';
}

function normalizeMarketRegime(
  raw?: string | null,
  waitCategory?: ChartAnalysisResult['waitCategory'],
): NonNullable<ChartAnalysisResult['marketRegime']> {
  if (waitCategory === 'MERCADO_LATERAL') return 'LATERAL';
  const up = (raw || '').toUpperCase().trim();
  if (up.includes('LATERAL') || up.includes('CONSOLID') || up.includes('RANGE')) return 'LATERAL';
  if (up.includes('ALTA') || up.includes('UPTREND') || up.includes('ALTIST')) return 'TENDENCIA_ALTA';
  if (up.includes('BAIXA') || up.includes('DOWNTREND') || up.includes('BAIXIST')) return 'TENDENCIA_BAIXA';
  if (up.includes('REVERS')) return 'REVERSAO';
  return 'INDETERMINADO';
}

function clampConfidencePct(value: unknown, fallback = 35): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(5, Math.min(MAX_CONFIDENCE_CAP, Math.round(value)));
}

export interface PolicyEvaluationInput {
  decision: ChartAnalysisResult['decision'];
  expectedDirection: 'SUBIDA' | 'QUEDA' | 'INDEFINIDA';
  buyConfidencePct?: number | null;
  sellConfidencePct?: number | null;
  bestDirection?: string | null;
  technicalConfidence?: number | null;
  analysisQuality: 'FORTE' | 'MODERADA' | 'INSUFICIENTE';
  waitCategory: ChartAnalysisResult['waitCategory'];
  marketRegime?: string | null;
  lateEntryDetected?: boolean;
  favorableEvidences: string[];
  contraryEvidences: string[];
  reason: string;
  riskWarning: string | null;
  entryTrigger?: string | null;
  nextAction?: string | null;
}

export interface PolicyEvaluationResult {
  decision: ChartAnalysisResult['decision'];
  expectedDirection: 'SUBIDA' | 'QUEDA' | 'INDEFINIDA';
  buyConfidencePct: number;
  sellConfidencePct: number;
  bestDirection: 'COMPRA' | 'VENDA' | 'INDEFINIDA';
  technicalConfidence: number;
  analysisQuality: 'FORTE' | 'MODERADA' | 'INSUFICIENTE';
  waitCategory: ChartAnalysisResult['waitCategory'];
  marketRegime: NonNullable<ChartAnalysisResult['marketRegime']>;
  lateEntryDetected: boolean;
  reason: string;
  entryTrigger: string | null;
  nextAction: string | null;
  recommendedWaitMinutes: number | null;
}

/**
 * Deterministic backend policy gate:
 * - Compares CALL vs PUT estimates conservatively (capped at 88%, never 95/99/100)
 * - Enforces 65% minimum threshold (<65% = AGUARDAR; =65% = AGUARDAR unless strong additional confirmation)
 * - Rejects sideways markets, contradictory signals, unreadable charts, and late/overextended entries
 */
export function evaluateDecisionAndConfidencePolicy(input: PolicyEvaluationInput): PolicyEvaluationResult {
  const rawDecision = input.decision;
  let buyPctNullable =
    typeof input.buyConfidencePct === 'number' && Number.isFinite(input.buyConfidencePct)
      ? clampConfidencePct(input.buyConfidencePct)
      : null;
  let sellPctNullable =
    typeof input.sellConfidencePct === 'number' && Number.isFinite(input.sellConfidencePct)
      ? clampConfidencePct(input.sellConfidencePct)
      : null;

  if (buyPctNullable === null && sellPctNullable === null) {
    const baseConf =
      typeof input.technicalConfidence === 'number' && Number.isFinite(input.technicalConfidence)
        ? clampConfidencePct(input.technicalConfidence)
        : 45;
    if (rawDecision === 'COMPRA') {
      buyPctNullable = baseConf;
      sellPctNullable = Math.max(10, Math.min(45, 100 - buyPctNullable));
    } else if (rawDecision === 'VENDA') {
      sellPctNullable = baseConf;
      buyPctNullable = Math.max(10, Math.min(45, 100 - sellPctNullable));
    } else {
      buyPctNullable = Math.min(52, baseConf);
      sellPctNullable = Math.min(52, baseConf);
    }
  }
  const buyPct: number =
    buyPctNullable !== null
      ? buyPctNullable
      : Math.max(10, Math.min(55, 100 - (sellPctNullable ?? 50)));
  const sellPct: number =
    sellPctNullable !== null
      ? sellPctNullable
      : Math.max(10, Math.min(55, 100 - buyPct));

  const waitCat = input.waitCategory;
  let marketRegime = normalizeMarketRegime(input.marketRegime, waitCat);
  const lateEntryDetected = Boolean(input.lateEntryDetected);

  const bestDirection: 'COMPRA' | 'VENDA' | 'INDEFINIDA' =
    buyPct > sellPct + 3 ? 'COMPRA' : sellPct > buyPct + 3 ? 'VENDA' : 'INDEFINIDA';

  const diffPct = Math.abs(buyPct - sellPct);
  const winningPct =
    bestDirection === 'COMPRA' ? buyPct : bestDirection === 'VENDA' ? sellPct : Math.max(buyPct, sellPct);

  const reject = (
    cat: NonNullable<ChartAnalysisResult['waitCategory']>,
    extraReason: string,
    defaultTrigger: string,
  ): PolicyEvaluationResult => {
    const waitMinutes = cat === 'IMAGEM_ILEGIVEL' ? 1 : 5;
    const cappedBuy =
      cat === 'IMAGEM_ILEGIVEL'
        ? Math.min(buyPct, 30)
        : cat === 'MERCADO_LATERAL' || cat === 'SINAIS_CONTRADITORIOS'
          ? Math.min(buyPct, 62)
          : buyPct;
    const cappedSell =
      cat === 'IMAGEM_ILEGIVEL'
        ? Math.min(sellPct, 30)
        : cat === 'MERCADO_LATERAL' || cat === 'SINAIS_CONTRADITORIOS'
          ? Math.min(sellPct, 62)
          : sellPct;
    const cappedWinning = Math.max(cappedBuy, cappedSell);
    const reasonText = input.reason.includes(extraReason)
      ? input.reason
      : `${extraReason} ${input.reason}`.trim();
    const waitNextAction =
      cat === 'IMAGEM_ILEGIVEL'
        ? 'Envie outra fotografia mais nítida focada nos candles e na escala de preços.'
        : 'Aguarde aproximadamente 5 minutos e envie uma nova foto do gráfico M1 para uma nova análise (sugestão de reavaliação, sem garantia de oportunidade).';

    return {
      decision: 'AGUARDAR',
      expectedDirection: 'INDEFINIDA',
      buyConfidencePct: cappedBuy,
      sellConfidencePct: cappedSell,
      bestDirection: cat === 'IMAGEM_ILEGIVEL' ? 'INDEFINIDA' : bestDirection,
      technicalConfidence: cappedWinning,
      analysisQuality: input.analysisQuality === 'FORTE' ? 'MODERADA' : input.analysisQuality,
      waitCategory: cat,
      marketRegime,
      lateEntryDetected,
      reason: reasonText,
      entryTrigger: input.entryTrigger || defaultTrigger,
      nextAction: input.nextAction || waitNextAction,
      recommendedWaitMinutes: waitMinutes,
    };
  };

  if (rawDecision === 'SINAL_EXPIRADO') {
    return {
      decision: 'SINAL_EXPIRADO',
      expectedDirection: 'INDEFINIDA',
      buyConfidencePct: buyPct,
      sellConfidencePct: sellPct,
      bestDirection,
      technicalConfidence: winningPct,
      analysisQuality: 'INSUFICIENTE',
      waitCategory: null,
      marketRegime,
      lateEntryDetected: true,
      reason: input.reason,
      entryTrigger: null,
      nextAction: 'Envie uma nova foto atualizada do gráfico para reavaliação completa.',
      recommendedWaitMinutes: 5,
    };
  }

  if (waitCat === 'IMAGEM_ILEGIVEL') {
    return reject(
      'IMAGEM_ILEGIVEL',
      'Imagem sem nitidez suficiente para distinguir estrutura e sequência completa de candles.',
      'Enviar nova captura nítida mostrando os últimos 30 a 60 candles e o eixo de preço.',
    );
  }

  if (marketRegime === 'LATERAL' || waitCat === 'MERCADO_LATERAL') {
    marketRegime = 'LATERAL';
    return reject(
      'MERCADO_LATERAL',
      'Mercado em lateralização/consolidação sem rompimento confirmado nem assimetria favorável.',
      'Aguardar rompimento limpo de topo ou fundo da consolidação com candle de força e reteste.',
    );
  }

  if (lateEntryDetected) {
    return reject(
      'AGUARDAR_CONFIRMACAO',
      'Entrada bloqueada por movimento já esticado ou atrasado (risco de operar no final do impulso).',
      'Aguardar recuo (pullback) para região de suporte/resistência antes de considerar nova operação.',
    );
  }

  if (
    waitCat === 'SINAIS_CONTRADITORIOS' ||
    bestDirection === 'INDEFINIDA' ||
    diffPct < 12 ||
    (buyPct >= 45 && sellPct >= 45)
  ) {
    return reject(
      'SINAIS_CONTRADITORIOS',
      `Sinais contraditórios entre força compradora (${buyPct}%) e vendedora (${sellPct}%), sem vantagem clara.`,
      'Aguardar candle de definição que rompa e confirme a direção dominante.',
    );
  }

  if (winningPct < MIN_CONFIDENCE_THRESHOLD) {
    return reject(
      waitCat || 'AGUARDAR_CONFIRMACAO',
      `Confiança técnica estimada (${winningPct}%) abaixo do limite mínimo exigido de ${MIN_CONFIDENCE_THRESHOLD}%.`,
      'Aguardar nova formação com mais confluências a favor da direção dominante.',
    );
  }

  if (winningPct === MIN_CONFIDENCE_THRESHOLD) {
    const strongAt65Allowed =
      (rawDecision === 'COMPRA' || rawDecision === 'VENDA') &&
      rawDecision === bestDirection &&
      input.analysisQuality === 'FORTE' &&
      input.favorableEvidences.length >= 3 &&
      input.contraryEvidences.length <= 1;

    if (!strongAt65Allowed) {
      return reject(
        waitCat || 'AGUARDAR_CONFIRMACAO',
        `Confiança técnica em exatamente ${MIN_CONFIDENCE_THRESHOLD}% sem confirmação adicional suficiente para liberar entrada com segurança.`,
        'Aguardar candle extra de confirmação ou rompimento/reteste limpo acima de 65%.',
      );
    }
  }

  if (rawDecision === 'AGUARDAR') {
    return reject(
      waitCat || 'AGUARDAR_CONFIRMACAO',
      `Apesar da vantagem parcial (${winningPct}%), a leitura técnica recomenda aguardar confirmação.`,
      'Aguardar fechamento do candle de gatilho na região marcada.',
    );
  }

  if (
    (rawDecision === 'COMPRA' && bestDirection !== 'COMPRA') ||
    (rawDecision === 'VENDA' && bestDirection !== 'VENDA')
  ) {
    return reject(
      'SINAIS_CONTRADITORIOS',
      `Inconsistência detectada entre a decisão (${rawDecision}) e a direção com maior confiança técnica (${bestDirection}).`,
      'Aguardar alinhamento completo entre leitura de candles e direção.',
    );
  }

  if (input.analysisQuality === 'INSUFICIENTE') {
    return reject(
      'AGUARDAR_CONFIRMACAO',
      'Qualidade técnica classificada como INSUFICIENTE pela validação conservadora.',
      'Aguardar formação de estrutura mais limpa antes de entrar.',
    );
  }

  return {
    decision: rawDecision,
    expectedDirection: rawDecision === 'COMPRA' ? 'SUBIDA' : 'QUEDA',
    buyConfidencePct: buyPct,
    sellConfidencePct: sellPct,
    bestDirection,
    technicalConfidence: winningPct,
    analysisQuality: input.analysisQuality,
    waitCategory: null,
    marketRegime,
    lateEntryDetected: false,
    reason: input.reason,
    entryTrigger: null,
    nextAction: null,
    recommendedWaitMinutes: null,
  };
}

export function validateSignalConsistency(params: {
  decision: ChartAnalysisResult['decision'];
  expectedDirection: 'SUBIDA' | 'QUEDA' | 'INDEFINIDA';
  entryWindowBrt: string | null;
  exitWindowBrt: string | null;
  expirationDuration: string | null;
  nowTimeBrt: string;
  nowUnixMs?: number;
  asset: string | null;
  timeframe?: string | null;
  reason: string;
  riskWarning: string | null;
}): {
  decision: ChartAnalysisResult['decision'];
  expectedDirection: 'SUBIDA' | 'QUEDA' | 'INDEFINIDA';
  entryWindowBrt: string | null;
  exitWindowBrt: string | null;
  expirationDuration: string | null;
  reason: string;
  nextAction: string | null;
  waitCategory: ChartAnalysisResult['waitCategory'];
} {
  let { decision, expectedDirection, entryWindowBrt, exitWindowBrt, expirationDuration, reason } = params;

  if (decision === 'SINAL_EXPIRADO' || decision === 'AGUARDAR') {
    return {
      decision,
      expectedDirection: 'INDEFINIDA',
      entryWindowBrt: null,
      exitWindowBrt: null,
      expirationDuration: null,
      reason,
      nextAction: null,
      waitCategory: decision === 'AGUARDAR' ? 'AGUARDAR_CONFIRMACAO' : null,
    };
  }

  // 1. Strict directional lock: COMPRA (CALL) = SUBIDA, VENDA (PUT) = QUEDA
  if (decision === 'COMPRA' && expectedDirection === 'QUEDA') {
    return {
      decision: 'AGUARDAR',
      expectedDirection: 'INDEFINIDA',
      entryWindowBrt: null,
      exitWindowBrt: null,
      expirationDuration: null,
      reason: `Sinal bloqueado por inconsistência direcional (COMPRA exige previsão de SUBIDA, mas o cenário apontou queda). ${reason}`,
      nextAction: 'Aguarde aproximadamente 5 minutos e envie uma nova foto do gráfico para reavaliação.',
      waitCategory: 'SINAIS_CONTRADITORIOS',
    };
  }
  if (decision === 'VENDA' && expectedDirection === 'SUBIDA') {
    return {
      decision: 'AGUARDAR',
      expectedDirection: 'INDEFINIDA',
      entryWindowBrt: null,
      exitWindowBrt: null,
      expirationDuration: null,
      reason: `Sinal bloqueado por inconsistência direcional (VENDA exige previsão de QUEDA, mas o cenário apontou subida). ${reason}`,
      nextAction: 'Aguarde aproximadamente 5 minutos e envie uma nova foto do gráfico para reavaliação.',
      waitCategory: 'SINAIS_CONTRADITORIOS',
    };
  }

  expectedDirection = decision === 'COMPRA' ? 'SUBIDA' : 'QUEDA';

  // 2. Strict future entry time validation relative to official server Brasília clock
  const nowMin = parseMinutesOfDay(params.nowTimeBrt);
  const entryMin = parseMinutesOfDay(entryWindowBrt);
  const exitMin = parseMinutesOfDay(exitWindowBrt);

  if (nowMin !== null && entryMin !== null) {
    let deltaEntry = entryMin - nowMin;
    if (deltaEntry < -720) deltaEntry += 1440; // midnight rollover guard
    if (deltaEntry > 720) deltaEntry -= 1440;
    if (deltaEntry < 0) {
      return {
        decision: 'AGUARDAR',
        expectedDirection: 'INDEFINIDA',
        entryWindowBrt: null,
        exitWindowBrt: null,
        expirationDuration: null,
        reason: `Sinal bloqueado para proteção de capital: o horário de entrada (${entryWindowBrt}) já passou em relação ao horário oficial de Brasília (${params.nowTimeBrt}). Nunca operar entrada retroativa.`,
        nextAction: 'Aguarde aproximadamente 5 minutos ou envie uma foto atualizada para recalcular a entrada.',
        waitCategory: 'AGUARDAR_CONFIRMACAO',
      };
    }
    // If entry was anchored to the current ongoing minute, advance cleanly to next candle open
    if (deltaEntry === 0) {
      entryWindowBrt = formatMinutesToBrt(nowMin + 1);
      exitWindowBrt = null;
    }
  }

  if (!expirationDuration) {
    const tfNorm = (params.timeframe || '').toLowerCase();
    expirationDuration = /^(1m|m1|1\s*min)/.test(tfNorm) || !tfNorm ? '2 min' : '5 min';
  }
  if (nowMin !== null && !entryWindowBrt) {
    entryWindowBrt = formatMinutesToBrt(nowMin + 1);
  }

  const resolvedEntryMin = parseMinutesOfDay(entryWindowBrt);
  if (resolvedEntryMin !== null && exitMin !== null && exitWindowBrt) {
    let deltaExit = exitMin - resolvedEntryMin;
    if (deltaExit <= -720) deltaExit += 1440;
    if (deltaExit <= 0) {
      return {
        decision: 'AGUARDAR',
        expectedDirection: 'INDEFINIDA',
        entryWindowBrt: null,
        exitWindowBrt: null,
        expirationDuration: null,
        reason: `Sinal retido por inconsistência no vencimento (${exitWindowBrt} não é posterior à entrada ${entryWindowBrt}).`,
        nextAction: 'Aguarde aproximadamente 5 minutos e envie uma nova foto do gráfico.',
        waitCategory: 'AGUARDAR_CONFIRMACAO',
      };
    }
  }

  if (resolvedEntryMin !== null && !exitWindowBrt) {
    const expMins = parseDurationMinutes(expirationDuration, params.timeframe);
    exitWindowBrt = formatMinutesToBrt(resolvedEntryMin + expMins);
  }

  return {
    decision,
    expectedDirection,
    entryWindowBrt,
    exitWindowBrt,
    expirationDuration,
    reason,
    nextAction: null,
    waitCategory: null,
  };
}

function formatWaitCategoryLabel(cat?: ChartAnalysisResult['waitCategory']): string {
  switch (cat) {
    case 'IMAGEM_ILEGIVEL':
      return 'IMAGEM ILEGÍVEL';
    case 'MERCADO_LATERAL':
      return 'MERCADO LATERAL';
    case 'SINAIS_CONTRADITORIOS':
      return 'SINAIS CONTRADITÓRIOS';
    case 'AGUARDAR_CONFIRMACAO':
      return 'AGUARDAR CONFIRMAÇÃO';
    default:
      return 'AGUARDAR CONFIRMAÇÃO';
  }
}

export function buildFormattedReport(
  raw: Omit<ChartAnalysisResult, 'formattedReport'>,
): string {
  const buyPctText =
    typeof raw.buyConfidencePct === 'number'
      ? `COMPRA (CALL): ${raw.buyConfidencePct}% de confiança estimada.`
      : null;
  const sellPctText =
    typeof raw.sellConfidencePct === 'number'
      ? `VENDA (PUT): ${raw.sellConfidencePct}% de confiança estimada.`
      : null;
  const bestDirText =
    raw.bestDirection && raw.bestDirection !== 'INDEFINIDA'
      ? `MELHOR DIREÇÃO: ${raw.bestDirection}.`
      : 'MELHOR DIREÇÃO: INDEFINIDA (sem vantagem clara).';

  if (raw.expired || raw.decision === 'SINAL_EXPIRADO') {
    return [
      'ANÁLISE DO GRÁFICO',
      '',
      'SINAL EXPIRADO — NÃO ENTRAR NESTA CONDIÇÃO. AGUARDAR NOVA OPORTUNIDADE.',
      raw.asset ? `Ativo: ${raw.asset}` : null,
      `Tempo gráfico: ${raw.timeframe || 'Não informado'}`,
      `Horário oficial: ${raw.analysisTimeBrt} BRT`,
      buyPctText,
      sellPctText,
      '',
      `MOTIVO: ${raw.reason}`,
      `RISCOS: ${raw.riskWarning || 'Entrada tardia reduz a assimetria da operação e aumenta risco de perda.'}`,
      `PRÓXIMA ANÁLISE: ${raw.nextAction || 'Envie outra foto em aproximadamente 5 minutos para nova leitura.'}`,
    ]
      .filter((line): line is string => Boolean(line || line === ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  if (raw.decision === 'AGUARDAR') {
    const waitMins = raw.recommendedWaitMinutes || 5;
    const nextPhotoLine =
      raw.waitCategory === 'IMAGEM_ILEGIVEL'
        ? 'Envie outra foto mais nítida assim que possível.'
        : raw.nextAction ||
          `Se quiser acompanhar a evolução, reavalie enviando uma nova foto em cerca de ${waitMins} minutos (sugestão prática, sem promessa de setup).`;

    return [
      'ANÁLISE DO GRÁFICO',
      '',
      raw.asset ? `Ativo: ${raw.asset}` : null,
      `Tempo gráfico: ${raw.timeframe || 'Não informado'}`,
      `Horário da análise: ${raw.analysisTimeBrt} BRT`,
      buyPctText,
      sellPctText,
      bestDirText,
      `QUALIDADE DA OPORTUNIDADE: ${raw.analysisQuality || 'INSUFICIENTE'}.`,
      `RECOMENDAÇÃO: AGUARDAR (${formatWaitCategoryLabel(raw.waitCategory)} — abaixo do limite mínimo de 65% ou sem confirmação completa; a decisão final é sempre sua).`,
      '',
      `MOTIVO: ${raw.reason}`,
      raw.favorableEvidences && raw.favorableEvidences.length > 0
        ? `FATORES TÉCNICOS OBSERVADOS:\n- ${raw.favorableEvidences.join('\n- ')}`
        : null,
      raw.contraryEvidences && raw.contraryEvidences.length > 0
        ? `PONTOS CONTRÁRIOS:\n- ${raw.contraryEvidences.join('\n- ')}`
        : null,
      `RISCOS: ${raw.riskWarning || 'Operar abaixo de 65% ou sem confirmação clara aumenta a chance de perda.'}`,
      raw.entryTrigger ? `O QUE PRECISA MELHORAR PARA SUBIR A CONFIANÇA: ${raw.entryTrigger}` : null,
      `REAVALIAÇÃO SUGERIDA: ${nextPhotoLine}`,
      raw.clarificationQuestion ? `PERGUNTA: ${raw.clarificationQuestion}` : null,
      '',
      raw.confidenceDisclaimer || CONFIDENCE_DISCLAIMER,
    ]
      .filter((line): line is string => Boolean(line || line === ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const decisionLabel = raw.decision === 'COMPRA' ? 'COMPRA (CALL)' : 'VENDA (PUT)';
  const m1OptionsLine =
    raw.expirationOptionsM1 && raw.expirationOptionsM1.length > 1
      ? ` (opções flexíveis em M1 conforme corretora: ${raw.expirationOptionsM1.join(', ')})`
      : '';

  return [
    'ANÁLISE DO GRÁFICO',
    '',
    raw.asset ? `Ativo: ${raw.asset}` : null,
    `Tempo gráfico: ${raw.timeframe || 'M1'}`,
    buyPctText,
    sellPctText,
    `MELHOR DIREÇÃO: ${raw.decision} (${decisionLabel}).`,
    `RECOMENDAÇÃO: ENTRADA CONSIDERÁVEL (${decisionLabel}).`,
    `HORÁRIO DE ENTRADA: ${raw.entryWindowBrt || 'Próximo candle (Brasília)'}`,
    `EXPIRAÇÃO: ${raw.expirationDuration || '2 min'}${m1OptionsLine}`,
    `ENCERRAMENTO: ${raw.exitWindowBrt || 'Conforme expiração (Brasília)'}`,
    raw.entryPrice ? `REGIÃO DE ENTRADA: ${raw.entryPrice}` : null,
    raw.stopLoss ? `INVALIDAÇÃO / STOP: ${raw.stopLoss}` : null,
    raw.targetPrice ? `ALVO TÉCNICO: ${raw.targetPrice}` : null,
    '',
    `MOTIVOS: ${raw.reason}`,
    raw.favorableEvidences && raw.favorableEvidences.length > 0
      ? `FATORES TÉCNICOS:\n- ${raw.favorableEvidences.join('\n- ')}`
      : null,
    `RISCOS: ${raw.riskWarning || raw.cancellationCondition || 'Reversão repentina ou rejeição em S/R próximo pode invalidar o sinal.'}`,
    raw.contraryEvidences && raw.contraryEvidences.length > 0
      ? `ATENÇÃO:\n- ${raw.contraryEvidences.join('\n- ')}`
      : null,
    '',
    raw.confidenceDisclaimer || CONFIDENCE_DISCLAIMER,
  ]
    .filter((line): line is string => Boolean(line || line === ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isEntryWindowStillValid(entryWindowBrt: string | null | undefined, nowShortBrt: string): boolean {
  if (!entryWindowBrt) return true;
  const nowMin = parseMinutesOfDay(nowShortBrt);
  const entryMin = parseMinutesOfDay(entryWindowBrt);
  if (nowMin === null || entryMin === null) return true;
  let delta = entryMin - nowMin;
  if (delta < -720) delta += 1440;
  if (delta > 720) delta -= 1440;
  return delta >= 0;
}

function buildPreviousPhotoComparison(
  prev: ChartAnalysisResult | undefined,
  current: Pick<
    ChartAnalysisResult,
    'asset' | 'decision' | 'buyConfidencePct' | 'sellConfidencePct' | 'bestDirection' | 'marketRegime' | 'analysisQuality'
  >,
): string | null {
  if (!prev) return null;
  const sameAsset =
    !prev.asset ||
    !current.asset ||
    prev.asset.toUpperCase().replace(/\s+/g, '') === current.asset.toUpperCase().replace(/\s+/g, '');
  if (!sameAsset) {
    return `Troca de ativo em relação à leitura anterior (${prev.asset} -> ${current.asset || 'novo gráfico'}): análise feita de forma independente.`;
  }

  const prevBuy = typeof prev.buyConfidencePct === 'number' ? prev.buyConfidencePct : null;
  const prevSell = typeof prev.sellConfidencePct === 'number' ? prev.sellConfidencePct : null;
  const curBuy = typeof current.buyConfidencePct === 'number' ? current.buyConfidencePct : 0;
  const curSell = typeof current.sellConfidencePct === 'number' ? current.sellConfidencePct : 0;

  const pctDeltaNote =
    prevBuy !== null && prevSell !== null
      ? `COMPRA ${prevBuy}% -> ${curBuy}% e VENDA ${prevSell}% -> ${curSell}%`
      : `cenário anterior (${prev.decision}) -> atual (${current.decision})`;

  let trendNote = 'o gráfico manteve configuração semelhante e segue sem vantagem acima de 65%.';
  if ((current.decision === 'COMPRA' || current.decision === 'VENDA') && prev.decision === 'AGUARDAR') {
    trendNote = 'a estrutura evoluiu em relação à foto anterior e destravou confirmação acima do mínimo de 65%.';
  } else if (prev.bestDirection && current.bestDirection && prev.bestDirection !== current.bestDirection && current.bestDirection !== 'INDEFINIDA') {
    trendNote = `houve mudança de força dominante (${prev.bestDirection} -> ${current.bestDirection}).`;
  } else if (current.marketRegime && prev.marketRegime && current.marketRegime !== prev.marketRegime) {
    trendNote = `o regime mudou de ${prev.marketRegime} para ${current.marketRegime}.`;
  } else if (Math.max(curBuy, curSell) > Math.max(prevBuy ?? 0, prevSell ?? 0) + 4) {
    trendNote = 'houve leve ganho de clareza na direção dominante, mas avalie os riscos apontados.';
  } else if (current.decision === 'AGUARDAR' && prev.decision === 'AGUARDAR') {
    trendNote = 'o cenário continua desfavorável/travado em comparação à foto anterior, mantendo a leitura abaixo da zona ideal de entrada.';
  }

  return `Comparação com a foto anterior (${prev.analysisTimeBrt} BRT): ${pctDeltaNote}; ${trendNote}`;
}

async function runChartAnalysisUncached(params: {
  imageDataUrl: string;
  userMessage?: string;
  photoReceivedAtBrt?: string;
  history?: ChatMessage[];
  tenant?: AiTenantContext;
}): Promise<AnalysisBundle> {
  const tStart = Date.now();
  await assertNotInRateLimitCooldown(params.tenant);
  const ai = getGeminiClient();
  const { mimeType, data } = parseBase64Image(params.imageDataUrl);
  const imagePart = { inlineData: { mimeType, data } };
  const imageRefHash = crypto
    .createHash('sha256')
    .update(params.imageDataUrl)
    .digest('hex')
    .slice(0, 16);

  // Extract hints strictly from the caption of THIS photo (never inherit stale asset from previous photo)
  const hints = extractHintsFromText(params.userMessage, null, null);

  let detectedAsset: string | null = hints.assetHint;
  let detectedTimeframe: string | null = hints.timeframeHint;
  let isOtcChart = hints.isOtcHint;
  let chartLastPrice: number | null = null;

  let timeSyncMs = 0;
  let quoteMs = 0;
  let geminiMs = 0;
  let timeSync: BrasiliaTimeSync;
  let marketQuote: MarketQuote | null = null;

  if (detectedAsset) {
    // Asset already known from caption: run time sync + live quote in parallel
    const lookupAsset = detectedAsset.replace(/\bOTC\b/gi, '').trim() || detectedAsset;
    const tSyncStart = Date.now();
    const tQuoteStart = Date.now();
    const [syncRes, quoteRes] = await Promise.all([
      getSynchronizedBrasiliaTime(false).then((r) => {
        timeSyncMs = Date.now() - tSyncStart;
        return r;
      }),
      fetchMarketQuote(lookupAsset, detectedTimeframe).then((r) => {
        quoteMs = Date.now() - tQuoteStart;
        return r;
      }),
    ]);
    timeSync = syncRes;
    marketQuote = quoteRes;
  } else {
    // Asset unknown: run timeSync in parallel with lightweight Pass 1 visual extraction
    const tSyncStart = Date.now();
    const tPass1Start = Date.now();
    try {
      const pass1Contents = validateGeminiContents([
        {
          role: 'user',
          parts: [
            imagePart,
            {
              text: [
                'Extraia apenas se é um gráfico financeiro, se os candles estão legíveis, o nome do ativo (preservando "OTC" se aparecer no gráfico e marcando isOtc=true), o timeframe e o último preço visível.',
                'IMPORTANTE SOBRE LEGIBILIDADE: marque imageReadable=true sempre que for possível distinguir os candles e o movimento de preço, mesmo sem indicadores na tela, com variação no tamanho dos candles, leve reflexo ou ticker parcialmente cortado.',
                'Marque imageReadable=false SOMENTE se NÃO for um gráfico financeiro ou se estiver totalmente borrado/pixelado a ponto de impedir distinguir os candles.',
                'Se imageReadable=false, explique unreadableReason em português (PT-BR).',
              ].join(' '),
            },
          ],
        },
      ]);

      const [syncRes, extractResp] = await Promise.all([
        getSynchronizedBrasiliaTime(false).then((r) => {
          timeSyncMs = Date.now() - tSyncStart;
          return r;
        }),
        ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: pass1Contents,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            responseMimeType: 'application/json',
            responseSchema: VISUAL_EXTRACTION_SCHEMA,
          },
        }),
      ]);
      geminiMs += Date.now() - tPass1Start;
      timeSync = syncRes;
      await recordGeminiSuccess(extractResp.usageMetadata, params.tenant);

      const extracted = parseGeminiJsonSafe<VisualExtraction>(extractResp.text ?? '{}', {
        isFinancialChart: true,
        imageReadable: true,
        unreadableReason: null,
        asset: null,
        timeframe: null,
        chartLastPrice: null,
      });
      if (extracted.isOtc || /\bOTC\b/i.test(extracted.asset || '')) {
        isOtcChart = true;
      }

      if (!extracted.isFinancialChart || !extracted.imageReadable) {
        const photoReceivedBrt = params.photoReceivedAtBrt || `${timeSync.dateBrt} ${timeSync.timeBrt}`;
        const reason =
          extracted.unreadableReason ||
          'A imagem não permite distinguir os candles ou não apresenta um gráfico financeiro legível.';
        const base: Omit<ChartAnalysisResult, 'formattedReport'> = {
          decision: 'AGUARDAR',
          expectedDirection: 'INDEFINIDA',
          expired: false,
          asset: extracted.asset || null,
          normalizedSymbol: null,
          timeframe: extracted.timeframe || null,
          analysisTimeBrt: `${timeSync.dateBrt} ${timeSync.timeBrt}`,
          photoReceivedAtBrt: photoReceivedBrt,
          entryWindowBrt: null,
          exitWindowBrt: null,
          timeRemainingToEntry: null,
          signalValidity: null,
          entryPrice: null,
          targetPrice: null,
          stopLoss: null,
          technicalConfidence: 15,
          buyConfidencePct: 15,
          sellConfidencePct: 15,
          bestDirection: 'INDEFINIDA',
          confidenceDisclaimer: CONFIDENCE_DISCLAIMER,
          marketRegime: 'INDETERMINADO',
          lateEntryDetected: false,
          recommendedWaitMinutes: 1,
          analysisQuality: 'INSUFICIENTE',
          waitCategory: 'IMAGEM_ILEGIVEL',
          favorableEvidences: [],
          contraryEvidences: [reason],
          entryTrigger: 'Enviar uma nova fotografia mais nítida focada nos últimos 30 a 60 candles e no eixo de preços.',
          reason,
          riskWarning: 'Operar sem leitura nítida dos candles impede avaliar tendência e níveis de rejeição.',
          entryCondition: null,
          cancellationCondition: null,
          nextAction: 'Envie outra fotografia mais nítida enquadrando os candles e a escala de preços.',
          dataFreshnessStatus: 'SEM_COTACAO_TEMPO_REAL',
          dataFreshnessNote: 'Análise interrompida por imagem ilegível.',
          needsClarification: 'NEW_PHOTO',
          clarificationQuestion: 'Poderia enviar outra fotografia mais nítida enquadrando os candles?',
          visibleIndicators: [],
        };
        const totalMs = Date.now() - tStart;
        await recordLatency('image', totalMs, params.tenant);
        return {
          analysis: { ...base, formattedReport: buildFormattedReport(base) },
          marketQuote: null,
          timeSync,
          timings: { totalMs, timeSyncMs, quoteMs, geminiMs },
        };
      }

      detectedAsset = extracted.asset || null;
      if (detectedAsset && isOtcChart && !/\bOTC\b/i.test(detectedAsset)) {
        detectedAsset = `${detectedAsset} OTC`;
      }
      detectedTimeframe = extracted.timeframe || detectedTimeframe;
      chartLastPrice = typeof extracted.chartLastPrice === 'number' ? extracted.chartLastPrice : null;
    } catch (err) {
      const safeErr = await recordGeminiFailure(err, params.tenant);
      throw new Error(safeErr);
    }

    if (detectedAsset) {
      const lookupAsset = detectedAsset.replace(/\bOTC\b/gi, '').trim() || detectedAsset;
      const tQuoteStart = Date.now();
      marketQuote = await fetchMarketQuote(lookupAsset, detectedTimeframe);
      quoteMs = Date.now() - tQuoteStart;
    }
  }

  const photoReceivedBrt = params.photoReceivedAtBrt || `${timeSync.dateBrt} ${timeSync.timeBrt}`;
  const analysisNow = await getSynchronizedBrasiliaTime(false);
  const quoteCtx = formatQuoteContext(marketQuote, chartLastPrice, isOtcChart);

  const isM1Context =
    !detectedTimeframe || /^(1m|m1|1\s*min)/i.test(detectedTimeframe.trim());

  const systemInstruction = [
    'Analista técnico conservador especializado em leitura de gráficos financeiros e opções binárias (PT-BR). Priorize proteção do capital e operações com evidências visíveis consistentes.',
    'LÓGICA DE OPÇÕES BINÁRIAS (NUNCA INVERTER): COMPRA (CALL) = previsão de SUBIDA (preço fecha ACIMA da entrada). VENDA (PUT) = previsão de QUEDA (preço fecha ABAIXO da entrada).',
    'INSPEÇÃO COMPLETA DA IMAGEM (DE CIMA A BAIXO): examine todos os candles visíveis (corpos e pavios; abertura, fechamento, máxima e mínima quando identificáveis), sequência de candles, força compradora e vendedora, tendência de alta/baixa/lateralização, topos e fundos, suportes e resistências, rompimentos e falsos rompimentos, retestes, pullbacks, rejeições de preço, padrões claros (engolfo de alta/baixa, martelo, estrela cadente, doji, pin bar), momentum/perda de força, possíveis mudanças de tendência, indicadores técnicos SOMENTE quando realmente visíveis e posição atual do preço em relação à estrutura.',
    'PROIBIDO: decidir apenas pela cor do último candle; inventar indicadores, preços, ativos, horários ou dados de M5/M15 que não estejam na imagem/contexto; recomendar martingale ou dobrar após perda; prometer vitória garantida.',
    'AVALIAÇÃO COMPARATIVA DE CONFIANÇA: avalie separadamente buyConfidencePct (COMPRA/CALL) e sellConfidencePct (VENDA/PUT) de forma conservadora (MÁXIMO 88%, NUNCA 95%, 99% ou 100%). Os percentuais representam estimativa de confiança técnica baseada em evidências visíveis, NÃO probabilidade matemática comprovada.',
    'REGRA DE 65%: abaixo de 65% => decision="AGUARDAR"; exatamente 65% => "AGUARDAR", salvo setup FORTE com confirmações adicionais robustas; acima de 65% => considerar entrada somente se todas as validações passarem. Sempre force AGUARDAR em sinais contraditórios, imagem ilegível, mercado lateral (marketRegime="LATERAL"), movimento exaurido ou entrada atrasada/esticada (lateEntryDetected=true).',
    'REGRAS M1: analise os últimos 30 a 60 candles visíveis. Não entrar todo minuto. Permita expirações flexíveis em M1 conforme estrutura e corretora (1 min, 2 min, 3 min ou 5 min). Só use M5/M15 se realmente fornecidos.',
    'SEM EXCESSO DE AGUARDAR QUANDO HÁ SETUP LIMPO: se a imagem for legível e apresentar estrutura clara (ex.: tendência limpa com topos/fundos alinhados, pullback confirmado em S/R, rompimento consistente ou rejeição dupla com candle de confirmação) com confiança > 65%, libere COMPRA ou VENDA com entrada futura (>= ' + analysisNow.shortTimeBrt + ' BRT) e expiração posterior.',
  ].join(' ');

  const decisionPrompt = [
    `BRASÍLIA AGORA (RELÓGIO OFICIAL DO SERVIDOR): ${analysisNow.dateBrt} ${analysisNow.timeBrt} (${analysisNow.shortTimeBrt} BRT) | FOTO RECEBIDA: ${photoReceivedBrt}`,
    detectedAsset ? `ATIVO DETECTADO: ${detectedAsset}${isOtcChart ? ' (MERCADO OTC)' : ''}` : 'ATIVO: detectar na foto; se cortado, analise os candles normalmente com asset=null.',
    detectedTimeframe ? `TIMEFRAME: ${detectedTimeframe}` : 'TIMEFRAME: detectar na foto (se compatível com candles curtos de binárias sem legenda, considere M1).',
    params.userMessage ? `SOLICITAÇÃO / CONTEXTO DO USUÁRIO: "${params.userMessage}"` : null,
    isM1Context
      ? 'MODO M1 ATIVO: examine de 30 a 60 candles visíveis. Não force entrada a cada minuto. Para sinais válidos em M1, defina expirationDuration entre "1 min", "2 min", "3 min" ou "5 min" conforme a estrutura e preencha expirationOptionsM1.'
      : 'Use exclusivamente o timeframe visível/fornecido (não invente M5 ou M15 se não enviados).',
    `REFERÊNCIA DE MERCADO:\n${quoteCtx.contextText}`,
    'INSTRUÇÕES DE SAÍDA JSON:',
    '- Informe buyConfidencePct e sellConfidencePct (inteiros <= 88, nunca 95/99/100), bestDirection ("COMPRA" | "VENDA" | "INDEFINIDA"), marketRegime ("TENDENCIA_ALTA" | "TENDENCIA_BAIXA" | "LATERAL" | "REVERSAO" | "INDETERMINADO") e lateEntryDetected (boolean).',
    '- COMPRA => expectedDirection="SUBIDA"; VENDA => expectedDirection="QUEDA"; AGUARDAR => expectedDirection="INDEFINIDA".',
    `- Para COMPRA/VENDA (> 65% ou = 65% FORTE): entryWindowBrt estritamente futuro (>= ${analysisNow.shortTimeBrt} BRT, calculado pelo relógio oficial e nunca pela hora impressa na foto), expirationDuration e exitWindowBrt estritamente posterior à entrada.`,
    '- Para AGUARDAR: waitCategory obrigatório (IMAGEM_ILEGIVEL | MERCADO_LATERAL | SINAIS_CONTRADITORIOS | AGUARDAR_CONFIRMACAO), entryTrigger descrevendo o que falta acontecer, favorableEvidences e contraryEvidences.',
    '- NÃO marque SINAL_EXPIRADO em gráficos OTC apenas por diferença de preço frente ao spot externo.',
  ]
    .filter(Boolean)
    .join('\n');

  let finalText = '{}';
  try {
    await assertNotInRateLimitCooldown(params.tenant);
    const tGemStart = Date.now();
    const pass2Contents = validateGeminiContents([
      {
        role: 'user',
        parts: [imagePart, { text: decisionPrompt }],
      },
    ]);
    const finalResp = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: pass2Contents,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        responseMimeType: 'application/json',
        responseSchema: FINAL_DECISION_SCHEMA,
      },
    });
    geminiMs += Date.now() - tGemStart;
    await recordGeminiSuccess(finalResp.usageMetadata, params.tenant);
    finalText = (finalResp.text ?? '{}').trim();
  } catch (err) {
    const safeErr = await recordGeminiFailure(err, params.tenant);
    throw new Error(safeErr);
  }

  const parsed = parseGeminiJsonSafe<{
    decision?: string;
    expectedDirection?: string;
    buyConfidencePct?: number | null;
    sellConfidencePct?: number | null;
    bestDirection?: string | null;
    marketRegime?: string | null;
    lateEntryDetected?: boolean;
    analysisQuality?: string;
    waitCategory?: string | null;
    expired?: boolean;
    asset?: string | null;
    timeframe?: string | null;
    entryWindowBrt?: string | null;
    expirationDuration?: string | null;
    expirationOptionsM1?: string[] | null;
    exitWindowBrt?: string | null;
    timeRemainingToEntry?: string | null;
    signalValidity?: string | null;
    entryPrice?: string | null;
    targetPrice?: string | null;
    stopLoss?: string | null;
    technicalConfidence?: number | null;
    reason?: string;
    riskWarning?: string | null;
    favorableEvidences?: string[];
    contraryEvidences?: string[];
    entryTrigger?: string | null;
    entryCondition?: string | null;
    cancellationCondition?: string | null;
    nextAction?: string | null;
    needsClarification?: 'ASSET' | 'TIMEFRAME' | 'NEW_PHOTO' | null;
    clarificationQuestion?: string | null;
    visibleIndicators?: string[];
  }>(finalText, {});

  let rawDecision = parsed.expired
    ? 'SINAL_EXPIRADO'
    : normalizeDecisionValue(parsed.decision);
  if (isOtcChart && rawDecision === 'SINAL_EXPIRADO') {
    rawDecision = 'AGUARDAR';
  }
  const rawDirection = normalizeExpectedDirection(parsed.expectedDirection);
  const finalAsset = parsed.asset ?? detectedAsset ?? null;
  const finalTimeframe = parsed.timeframe ?? detectedTimeframe ?? null;

  const favorableList = Array.isArray(parsed.favorableEvidences)
    ? parsed.favorableEvidences.filter((x) => typeof x === 'string' && x.trim().length > 0)
    : [];
  const contraryList = Array.isArray(parsed.contraryEvidences)
    ? parsed.contraryEvidences.filter((x) => typeof x === 'string' && x.trim().length > 0)
    : [];

  const preliminaryQuality = normalizeAnalysisQuality(parsed.analysisQuality, rawDecision);
  const preliminaryWaitCat = normalizeWaitCategory(parsed.waitCategory, rawDecision);

  // 1. Apply deterministic confidence comparison & 65% gate
  const policy = evaluateDecisionAndConfidencePolicy({
    decision: rawDecision,
    expectedDirection: rawDirection,
    buyConfidencePct: parsed.buyConfidencePct ?? null,
    sellConfidencePct: parsed.sellConfidencePct ?? null,
    bestDirection: parsed.bestDirection ?? null,
    technicalConfidence: parsed.technicalConfidence ?? null,
    analysisQuality: preliminaryQuality,
    waitCategory: preliminaryWaitCat,
    marketRegime: parsed.marketRegime ?? null,
    lateEntryDetected: Boolean(parsed.lateEntryDetected),
    favorableEvidences: favorableList,
    contraryEvidences: contraryList,
    reason: parsed.reason || 'Análise técnica concluída com base nos candles visíveis.',
    riskWarning: parsed.riskWarning ?? parsed.cancellationCondition ?? null,
    entryTrigger: parsed.entryTrigger ?? null,
    nextAction: parsed.nextAction ?? null,
  });

  // 2. Validate future entry/expiration timeline against official Brasília clock
  const validated = validateSignalConsistency({
    decision: policy.decision,
    expectedDirection: policy.expectedDirection,
    entryWindowBrt: policy.decision === 'COMPRA' || policy.decision === 'VENDA' ? (parsed.entryWindowBrt ?? null) : null,
    exitWindowBrt: policy.decision === 'COMPRA' || policy.decision === 'VENDA' ? (parsed.exitWindowBrt ?? null) : null,
    expirationDuration: policy.decision === 'COMPRA' || policy.decision === 'VENDA' ? (parsed.expirationDuration ?? null) : null,
    nowTimeBrt: analysisNow.shortTimeBrt,
    nowUnixMs: analysisNow.unixMs,
    asset: finalAsset,
    timeframe: finalTimeframe,
    reason: policy.reason,
    riskWarning: parsed.riskWarning ?? parsed.cancellationCondition ?? null,
  });

  const finalQuality =
    validated.decision === 'AGUARDAR' && policy.analysisQuality === 'FORTE'
      ? 'MODERADA'
      : policy.analysisQuality;
  const finalWaitCat =
    validated.decision === 'AGUARDAR'
      ? policy.waitCategory || validated.waitCategory || 'AGUARDAR_CONFIRMACAO'
      : null;

  const isM1Resolved =
    !finalTimeframe || /^(1m|m1|1\s*min)/i.test(finalTimeframe.trim());
  const rawOptionsM1 = Array.isArray(parsed.expirationOptionsM1)
    ? parsed.expirationOptionsM1.filter((x) => typeof x === 'string' && x.trim().length > 0)
    : [];
  const expirationOptionsM1 =
    isM1Resolved && (validated.decision === 'COMPRA' || validated.decision === 'VENDA')
      ? rawOptionsM1.length > 0
        ? rawOptionsM1
        : ['1 min', '2 min', '3 min', '5 min']
      : undefined;

  const recommendedWaitMinutes =
    validated.decision === 'AGUARDAR'
      ? (policy.recommendedWaitMinutes ?? (finalWaitCat === 'IMAGEM_ILEGIVEL' ? 1 : 5))
      : null;

  const prevHistoryAnalysis = [...(params.history || [])]
    .reverse()
    .find((m) => Boolean(m.analysis))?.analysis;
  const comparisonNote = buildPreviousPhotoComparison(prevHistoryAnalysis, {
    asset: finalAsset,
    decision: validated.decision,
    buyConfidencePct: policy.buyConfidencePct,
    sellConfidencePct: policy.sellConfidencePct,
    bestDirection: policy.bestDirection,
    marketRegime: policy.marketRegime,
    analysisQuality: finalQuality,
  });

  const baseResult: Omit<ChartAnalysisResult, 'formattedReport'> = {
    decision: validated.decision,
    expectedDirection: validated.expectedDirection,
    expired: Boolean((parsed.expired && !isOtcChart) || validated.decision === 'SINAL_EXPIRADO'),
    asset: finalAsset,
    normalizedSymbol: marketQuote?.available && !isOtcChart ? marketQuote.symbol : null,
    timeframe: finalTimeframe,
    analysisTimeBrt: `${analysisNow.dateBrt} ${analysisNow.timeBrt}`,
    photoReceivedAtBrt: photoReceivedBrt,
    entryWindowBrt: validated.entryWindowBrt,
    expirationDuration: validated.expirationDuration,
    expirationOptionsM1,
    exitWindowBrt: validated.exitWindowBrt,
    timeRemainingToEntry:
      validated.decision === 'COMPRA' || validated.decision === 'VENDA'
        ? (parsed.timeRemainingToEntry ?? 'Aguardar abertura do próximo candle')
        : null,
    signalValidity:
      validated.decision === 'COMPRA' || validated.decision === 'VENDA'
        ? (parsed.signalValidity ?? validated.expirationDuration ?? null)
        : null,
    entryPrice: parsed.entryPrice ?? null,
    targetPrice: parsed.targetPrice ?? null,
    stopLoss: parsed.stopLoss ?? null,
    technicalConfidence: policy.technicalConfidence,
    buyConfidencePct: policy.buyConfidencePct,
    sellConfidencePct: policy.sellConfidencePct,
    bestDirection: policy.bestDirection,
    confidenceDisclaimer: CONFIDENCE_DISCLAIMER,
    marketRegime: policy.marketRegime,
    lateEntryDetected: policy.lateEntryDetected,
    recommendedWaitMinutes,
    analysisQuality: finalQuality,
    waitCategory: finalWaitCat,
    favorableEvidences: favorableList,
    contraryEvidences: contraryList,
    entryTrigger:
      validated.decision === 'AGUARDAR'
        ? (policy.entryTrigger ?? parsed.entryTrigger ?? parsed.nextAction ?? 'Aguardar candle de confirmação alinhado à estrutura.')
        : null,
    reason: comparisonNote ? `${validated.reason} ${comparisonNote}` : validated.reason,
    riskWarning: parsed.riskWarning ?? parsed.cancellationCondition ?? null,
    entryCondition: parsed.entryCondition ?? null,
    cancellationCondition: parsed.cancellationCondition ?? parsed.riskWarning ?? null,
    nextAction:
      validated.decision === 'AGUARDAR'
        ? (validated.nextAction ??
          policy.nextAction ??
          parsed.nextAction ??
          'Reavalie enviando uma nova foto do gráfico M1 em cerca de 3 a 5 minutos.')
        : (validated.nextAction ?? parsed.nextAction ?? null),
    dataFreshnessStatus: quoteCtx.freshnessStatus,
    dataFreshnessNote: quoteCtx.freshnessNote,
    needsClarification: parsed.needsClarification ?? null,
    clarificationQuestion: parsed.clarificationQuestion ?? null,
    visibleIndicators: parsed.visibleIndicators || [],
  };

  const finalAnalysis: ChartAnalysisResult = {
    ...baseResult,
    formattedReport: buildFormattedReport(baseResult),
  };

  if (!finalAnalysis.expired && (finalAnalysis.decision === 'COMPRA' || finalAnalysis.decision === 'VENDA')) {
    await recordEmittedSignal({
      analysis: finalAnalysis,
      marketQuote,
      origin: 'LIVE_AI',
      imageRefHash,
      tenant: params.tenant,
    }).catch(() => {});
  }

  const totalMs = Date.now() - tStart;
  await recordLatency('image', totalMs, params.tenant);

  return {
    analysis: finalAnalysis,
    marketQuote,
    timeSync: analysisNow,
    timings: { totalMs, timeSyncMs, quoteMs, geminiMs },
  };
}

export async function analyzeChartImage(params: {
  imageDataUrl: string;
  userMessage?: string;
  photoReceivedAtBrt?: string;
  history?: ChatMessage[];
  tenant?: AiTenantContext;
}): Promise<AnalysisBundle> {
  // Never inherit previous photo's asset/timeframe in cache key so new photos stay isolated
  const cacheKey = computeAnalysisCacheKey(
    params.imageDataUrl,
    params.userMessage,
    null,
    null,
    params.tenant,
  );

  // 1. Return cached result if still valid AND its entry window has not fallen into the past
  const cached = analysisCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const cachedDec = cached.result.analysis.decision;
    const nowShortBrt = formatTimestampBrt(Date.now()).shortTimeBrt;
    if (
      (cachedDec === 'COMPRA' || cachedDec === 'VENDA') &&
      !isEntryWindowStillValid(cached.result.analysis.entryWindowBrt, nowShortBrt)
    ) {
      analysisCache.delete(cacheKey);
    } else {
      await recordCacheHit(params.tenant);
      return cached.result;
    }
  }

  // 2. Deduplicate concurrent identical requests within THIS isolated tenant+conversation
  const existingPromise = inFlightAnalyses.get(cacheKey);
  if (existingPromise) {
    await recordDeduplicatedRequest(params.tenant);
    return existingPromise;
  }

  const runPromise = runChartAnalysisUncached(params)
    .then((bundle) => {
      analysisCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, result: bundle });
      if (analysisCache.size > 30) {
        const firstKey = analysisCache.keys().next().value;
        if (firstKey) analysisCache.delete(firstKey);
      }
      return bundle;
    })
    .finally(() => {
      inFlightAnalyses.delete(cacheKey);
    });

  inFlightAnalyses.set(cacheKey, runPromise);
  return runPromise;
}

function isPureTimeQuery(text: string): boolean {
  return /^(qual\s+(é\s+o\s+|o\s+)?hor[áa]rio(\s+atual)?(\s+de\s+bras[íi]lia)?|que\s+horas?\s+(s[ãa]o|é)(\s+agora)?(\s+em\s+bras[íi]lia)?|hora\s+atual(\s+em\s+bras[íi]lia)?)\??$/i.test(
    text.trim(),
  );
}

function isPureQuoteQuery(text: string): boolean {
  return /^(qual\s+(a|é\s+a)?\s*)?(cota[çc][ãa]o|pre[çc]o|valor|quanto\s+(t[áa]|est[áa]|custa))\s+((atual\s+)?(do|da|de)\s+)?[a-z0-9./^-]{2,14}(\s+(hoje|agora))?\??$/i.test(
    text.trim(),
  );
}

export async function continueChartChat(params: {
  messages: ChatMessage[];
  userMessage: string;
  lastAsset?: string | null;
  lastTimeframe?: string | null;
  tenant?: AiTenantContext;
}): Promise<ChatBundle> {
  const tStart = Date.now();
  const trimmedMsg = params.userMessage.trim();

  // Pure TypeScript fast path 1: Brasília time query (zero Gemini tokens)
  if (isPureTimeQuery(trimmedMsg)) {
    const tSync = Date.now();
    const timeSync = await getSynchronizedBrasiliaTime(true);
    const timeSyncMs = Date.now() - tSync;
    const totalMs = Date.now() - tStart;
    await recordLatency('text', totalMs, params.tenant);
    return {
      replyText: `Horário oficial de Brasília agora: ${timeSync.dateBrt} às ${timeSync.timeBrt} BRT (America/Sao_Paulo).`,
      marketQuote: null,
      timeSync,
      timings: { totalMs, timeSyncMs, quoteMs: 0, geminiMs: 0 },
    };
  }

  const lastImageMsg = [...params.messages].reverse().find((m) => Boolean(m.imageDataUrl));
  const lastAnalysisMsg = [...params.messages].reverse().find((m) => Boolean(m.analysis));
  const prevAnalysis = lastAnalysisMsg?.analysis;

  const hints = extractHintsFromText(
    trimmedMsg,
    params.lastAsset || prevAnalysis?.asset,
    params.lastTimeframe || prevAnalysis?.timeframe,
  );
  const targetAsset = hints.assetHint;
  const targetTimeframe = hints.timeframeHint;

  // Deterministic temporal check: if user asks whether an active signal is still valid / can enter,
  // and its entry window has already elapsed in Brasília time, immediately expire & cancel it cleanly.
  const asksSignalValidity =
    /\b(ainda\s+posso|continua\s+v[áa]lid|vale\s+entrar|expirou|posso\s+entrar|entrar\s+agora|cancel\w*|invalid\w*)\b/i.test(
      trimmedMsg,
    );
  if (
    asksSignalValidity &&
    prevAnalysis &&
    (prevAnalysis.decision === 'COMPRA' || prevAnalysis.decision === 'VENDA') &&
    !prevAnalysis.expired &&
    prevAnalysis.entryWindowBrt
  ) {
    const tSync = Date.now();
    const timeSync = await getSynchronizedBrasiliaTime(false);
    const timeSyncMs = Date.now() - tSync;
    if (!isEntryWindowStillValid(prevAnalysis.entryWindowBrt, timeSync.shortTimeBrt)) {
      await invalidatePendingSignal({
        asset: prevAnalysis.asset,
        entryTimeBrt: prevAnalysis.entryWindowBrt,
        reason: 'Janela de entrada expirada antes da execução.',
        tenant: params.tenant,
      }).catch(() => {});

      const expiredReason = `O horário previsto de entrada (${prevAnalysis.entryWindowBrt} BRT) já passou em relação ao horário oficial de Brasília (${timeSync.shortTimeBrt} BRT). Não execute entrada atrasada.`;
      const expiredBase: Omit<ChartAnalysisResult, 'formattedReport'> = {
        ...prevAnalysis,
        decision: 'SINAL_EXPIRADO',
        expectedDirection: 'INDEFINIDA',
        expired: true,
        entryWindowBrt: null,
        exitWindowBrt: null,
        expirationDuration: null,
        timeRemainingToEntry: null,
        signalValidity: null,
        analysisTimeBrt: `${timeSync.dateBrt} ${timeSync.timeBrt}`,
        reason: expiredReason,
        riskWarning: 'Entrar fora da janela aumenta o risco de operar no final do movimento.',
        nextAction: 'Aguarde aproximadamente 5 minutos e envie uma nova foto do gráfico M1 para reavaliação.',
        recommendedWaitMinutes: 5,
      };
      const expiredAnalysis: ChartAnalysisResult = {
        ...expiredBase,
        formattedReport: buildFormattedReport(expiredBase),
      };
      const totalMs = Date.now() - tStart;
      await recordLatency('text', totalMs, params.tenant);
      return {
        replyText: `SINAL EXPIRADO — NÃO ENTRAR NESTA CONDIÇÃO. O horário de entrada (${prevAnalysis.entryWindowBrt} BRT) já passou (agora são ${timeSync.shortTimeBrt} BRT). Aguarde aproximadamente 5 minutos e envie uma nova foto para nova leitura.`,
        analysis: expiredAnalysis,
        marketQuote: null,
        timeSync,
        timings: { totalMs, timeSyncMs, quoteMs: 0, geminiMs: 0 },
      };
    }
  }

  // Pure TypeScript fast path 2: Pure quote lookup without AI analysis request (zero Gemini tokens)
  if (targetAsset && isPureQuoteQuery(trimmedMsg)) {
    const tSyncStart = Date.now();
    const tQuoteStart = Date.now();
    let timeSyncMs = 0;
    let quoteMs = 0;
    const [timeSync, liveQuote] = await Promise.all([
      getSynchronizedBrasiliaTime(false).then((r) => {
        timeSyncMs = Date.now() - tSyncStart;
        return r;
      }),
      fetchMarketQuote(targetAsset, targetTimeframe).then((r) => {
        quoteMs = Date.now() - tQuoteStart;
        return r;
      }),
    ]);

    if (liveQuote.available) {
      const varTxt =
        liveQuote.changePercent24h !== null
          ? ` (${liveQuote.changePercent24h >= 0 ? '+' : ''}${liveQuote.changePercent24h.toFixed(2)}%)`
          : '';
      const totalMs = Date.now() - tStart;
      await recordLatency('text', totalMs, params.tenant);
      return {
        replyText: `${liveQuote.displayName}: ${liveQuote.price.toLocaleString('pt-BR', { maximumFractionDigits: 6 })} ${liveQuote.currency}${varTxt} — fonte ${liveQuote.provider} às ${liveQuote.fetchedAtBrt} BRT.`,
        marketQuote: liveQuote,
        timeSync,
        timings: { totalMs, timeSyncMs, quoteMs, geminiMs: 0 },
      };
    }
  }

  // Deduplicate and short-cache identical chat queries strictly within THIS isolated tenant+conversation
  const tailKey = params.messages
    .slice(-3)
    .map((m) => `${m?.role || 'user'}:${typeof m?.text === 'string' ? m.text.slice(0, 80) : ''}`)
    .join('|');
  const tenantScopePrefix = `${params.tenant?.companyId || '_global'}|${params.tenant?.uid || '_anon'}|${params.tenant?.projectId || '_proj'}|${params.tenant?.conversationId || '_conv'}`;
  const chatKey = crypto
    .createHash('sha256')
    .update(`${tenantScopePrefix}|${trimmedMsg.toLowerCase()}|${targetAsset || ''}|${targetTimeframe || ''}|${tailKey}|${Boolean(lastImageMsg?.imageDataUrl)}`)
    .digest('hex');

  const cachedChat = chatCache.get(chatKey);
  if (cachedChat && cachedChat.expiresAt > Date.now()) {
    const cachedSignal = cachedChat.result.analysis;
    const nowShortBrt = formatTimestampBrt(Date.now()).shortTimeBrt;
    if (
      cachedSignal &&
      (cachedSignal.decision === 'COMPRA' || cachedSignal.decision === 'VENDA') &&
      !isEntryWindowStillValid(cachedSignal.entryWindowBrt, nowShortBrt)
    ) {
      chatCache.delete(chatKey);
    } else {
      await recordCacheHit(params.tenant);
      return cachedChat.result;
    }
  }

  const pendingChat = inFlightChats.get(chatKey);
  if (pendingChat) {
    await recordDeduplicatedRequest(params.tenant);
    return pendingChat;
  }

  const execPromise = (async (): Promise<ChatBundle> => {
    await assertNotInRateLimitCooldown(params.tenant);
    const ai = getGeminiClient();

    // Run timeSync (cached 60s) + live market quote (cached 15s) in parallel
    let timeSyncMs = 0;
    let quoteMs = 0;
    const tSyncStart = Date.now();
    const tQuoteStart = Date.now();

    const [timeSync, liveQuote] = await Promise.all([
      getSynchronizedBrasiliaTime(false).then((r) => {
        timeSyncMs = Date.now() - tSyncStart;
        return r;
      }),
      targetAsset
        ? fetchMarketQuote(targetAsset.replace(/\bOTC\b/gi, '').trim() || targetAsset, targetTimeframe).then((r) => {
            quoteMs = Date.now() - tQuoteStart;
            return r;
          })
        : Promise.resolve(null),
    ]);

    const quoteCtx = formatQuoteContext(liveQuote, null, hints.isOtcHint || /\bOTC\b/i.test(targetAsset || ''));
    const hasPhotoOrAnalysis = Boolean(lastImageMsg || prevAnalysis);
    const quoteSection = targetAsset
      ? quoteCtx.contextText
      : 'Nenhum ativo específico consultado nesta mensagem.';

    // Exclude duplicate trailing user message matching the active userMessage
    const lastMsgText =
      params.messages.length > 0 && typeof params.messages[params.messages.length - 1]?.text === 'string'
        ? params.messages[params.messages.length - 1].text.trim()
        : '';
    const priorMessages =
      params.messages.length > 0 &&
      params.messages[params.messages.length - 1]?.role === 'user' &&
      lastMsgText === params.userMessage.trim()
        ? params.messages.slice(0, -1)
        : params.messages;

    // Re-attach the chart image ONLY when clarifying missing asset/timeframe or explicitly asked to re-examine the photo
    const needsVisualReeval =
      Boolean(lastImageMsg?.imageDataUrl) &&
      (!prevAnalysis ||
        prevAnalysis.needsClarification === 'ASSET' ||
        prevAnalysis.needsClarification === 'TIMEFRAME' ||
        /\b(reanalis\w*|ver\s+(a\s+)?(imagem|foto)|olh[ae]\s+(a\s+)?(imagem|foto)|na\s+(imagem|foto))\b/i.test(
          params.userMessage,
        ));

    const recentAssistantReplies = priorMessages
      .filter((m) => m.role === 'assistant' && typeof m.text === 'string' && m.text.trim().length > 0)
      .slice(-2)
      .map((m) => m.text.trim().slice(0, 140));

    let photoElapsedNote = '';
    if (prevAnalysis?.analysisTimeBrt) {
      const prevMin = parseMinutesOfDay(prevAnalysis.analysisTimeBrt);
      const nowMin = parseMinutesOfDay(timeSync.shortTimeBrt);
      if (prevMin !== null && nowMin !== null) {
        let diff = nowMin - prevMin;
        if (diff < 0) diff += 1440;
        if (diff <= 180) {
          photoElapsedNote = ` (enviada há cerca de ${diff} minuto(s), às ${prevAnalysis.photoReceivedAtBrt || prevAnalysis.analysisTimeBrt} BRT)`;
        }
      }
    }

    const structuredSummaryForChat = prevAnalysis
      ? [
          `Ativo: ${prevAnalysis.asset || 'Não identificado'} | Timeframe: ${prevAnalysis.timeframe || 'M1'}`,
          `Decisão do motor: ${prevAnalysis.decision} | Qualidade: ${prevAnalysis.analysisQuality || 'MODERADA'} | Regime: ${prevAnalysis.marketRegime || 'INDETERMINADO'}`,
          typeof prevAnalysis.buyConfidencePct === 'number' || typeof prevAnalysis.sellConfidencePct === 'number'
            ? `Estimativas: COMPRA ${prevAnalysis.buyConfidencePct ?? '?'}% vs VENDA ${prevAnalysis.sellConfidencePct ?? '?'}% | Melhor cenário: ${prevAnalysis.bestDirection || 'INDEFINIDA'}`
            : null,
          prevAnalysis.entryTrigger ? `O que falta melhorar: ${prevAnalysis.entryTrigger}` : null,
          prevAnalysis.riskWarning ? `Riscos identificados: ${prevAnalysis.riskWarning}` : null,
        ]
          .filter(Boolean)
          .join(' | ')
      : null;

    const prompt = [
      `BRASÍLIA AGORA: ${timeSync.dateBrt} ${timeSync.timeBrt} (${timeSync.shortTimeBrt} BRT)`,
      hasPhotoOrAnalysis
        ? `ÚLTIMA ANÁLISE${photoElapsedNote}:\n${prevAnalysis ? prevAnalysis.formattedReport : 'Fotografia enviada anteriormente.'}\nRESUMO TÉCNICO: ${structuredSummaryForChat || 'Sem resumo adicional.'}`
        : 'MODO CONVERSA NATURAL (nenhuma fotografia enviada ainda): converse livremente de forma natural, inteligente e prestativa sem exigir foto para responder. Só marque shouldAttachStructuredCard=true se houver análise anterior formal que exija atualização de card.',
      `COTAÇÃO ATUAL:\n${quoteSection}`,
      recentAssistantReplies.length > 0
        ? `ANTI-REPETIÇÃO (varie sua abordagem e não repita frases mecânicas usadas antes): ${recentAssistantReplies.map((r, i) => `[Resp ${i + 1}: "${r}"]`).join(' ')}`
        : null,
      `PERGUNTA DO USUÁRIO: "${params.userMessage}"`,
      hasPhotoOrAnalysis
        ? [
            'DIRETRIZES CONVERSACIONAIS ADITIVAS:',
            '- Se o usuário perguntar se é uma boa hora para operar, avalie o horário e o contexto da última imagem, explique como está o mercado, informe se há oportunidade >= 65%, sugira um intervalo razoável para reavaliação (ex.: 3, 5 ou 10 minutos com justificativa técnica) e explique o que precisa melhorar no gráfico.',
            '- Se a confiança for menor que 65%, mas tecnicamente identificável, apresente melhor cenário, COMPRA%, VENDA%, qualidade da oportunidade, riscos e condições teóricas — deixando claro que está abaixo da referência mínima de 65% (menor confiabilidade, não é sinal confirmado) e que a decisão final é do usuário.',
            '- Se o sinal anterior já passou da entrada, alvo, stop ou horário, alerte claramente ("SINAL EXPIRADO — NÃO ENTRAR NESTA CONDIÇÃO") e oriente uma nova avaliação.',
          ].join(' ')
        : null,
    ]
      .filter(Boolean)
      .join('\n\n');

    const chatSchema = {
      type: Type.OBJECT,
      properties: {
        replyText: { type: Type.STRING },
        shouldAttachStructuredCard: { type: Type.BOOLEAN },
        decision: { type: Type.STRING, nullable: true },
        expectedDirection: { type: Type.STRING, nullable: true },
        buyConfidencePct: { type: Type.NUMBER, nullable: true },
        sellConfidencePct: { type: Type.NUMBER, nullable: true },
        bestDirection: { type: Type.STRING, nullable: true },
        marketRegime: { type: Type.STRING, nullable: true },
        lateEntryDetected: { type: Type.BOOLEAN, nullable: true },
        expired: { type: Type.BOOLEAN },
        asset: { type: Type.STRING, nullable: true },
        timeframe: { type: Type.STRING, nullable: true },
        entryWindowBrt: { type: Type.STRING, nullable: true },
        expirationDuration: { type: Type.STRING, nullable: true },
        expirationOptionsM1: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          nullable: true,
        },
        exitWindowBrt: { type: Type.STRING, nullable: true },
        timeRemainingToEntry: { type: Type.STRING, nullable: true },
        signalValidity: { type: Type.STRING, nullable: true },
        entryPrice: { type: Type.STRING, nullable: true },
        targetPrice: { type: Type.STRING, nullable: true },
        stopLoss: { type: Type.STRING, nullable: true },
        technicalConfidence: { type: Type.NUMBER, nullable: true },
        reason: { type: Type.STRING, nullable: true },
        riskWarning: { type: Type.STRING, nullable: true },
        entryCondition: { type: Type.STRING, nullable: true },
        cancellationCondition: { type: Type.STRING, nullable: true },
        nextAction: { type: Type.STRING, nullable: true },
      },
      required: ['replyText', 'shouldAttachStructuredCard', 'expired'],
    };

    const currentParts: Part[] = [];
    if (needsVisualReeval && lastImageMsg?.imageDataUrl) {
      currentParts.push({ inlineData: parseBase64Image(lastImageMsg.imageDataUrl) });
    }
    currentParts.push({ text: prompt });

    const { contents: rawChatContents, extraSystemInstructions } = buildGeminiContentsFromHistory({
      messages: priorMessages,
      currentUserParts: currentParts,
      maxHistoryTurns: 4,
    });
    const validatedChatContents = validateGeminiContents(rawChatContents);

    const systemInstruction = [
      'Analista financeiro conversacional conservador (PT-BR). Lógica de opções binárias: COMPRA (CALL) = previsão de SUBIDA acima da entrada no vencimento; VENDA (PUT) = previsão de QUEDA abaixo da entrada no vencimento. Limite mínimo de confiança: 65% (<65% ou sinais contraditórios/laterais = AGUARDAR como sinal oficial; nunca apresente sinais abaixo de 65% como oportunidades confirmadas). Nunca use 95%, 99% ou 100%, nunca aumente percentuais artificialmente, nunca prometa vitória, nunca recomende martingale ou dobrar mão e priorize proteção do capital.',
      'COMPORTAMENTO DINÂMICO E CONSULTIVO (ASSISTENTE HUMANA E PARTICIPATIVA): atue como uma consultora experiente e acessível, não como um robô autoritário que impede o usuário ou repete indefinidamente "aguarde", "espere" ou "não opere". Responda todas as perguntas de forma natural e direta, sem obrigar o usuário a mandar imagem para conversar e sem dizer apenas que analisa gráficos. Quando o usuário avaliar o momento ou um setup com confiança menor (<65%), apresente objetivamente o melhor cenário observado, COMPRA%, VENDA%, qualidade da oportunidade, riscos, o que falta melhorar no gráfico e sugira um prazo razoável de reavaliação (3, 5 ou 10 minutos conforme o contexto), deixando claro que está abaixo de 65% e que a decisão final é sempre do usuário.',
      ...extraSystemInstructions,
    ]
      .filter(Boolean)
      .join(' ');

    let rawJson = '{}';
    let geminiMs = 0;
    try {
      const tGemStart = Date.now();
      const resp = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: validatedChatContents,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          responseMimeType: 'application/json',
          responseSchema: chatSchema,
        },
      });
      geminiMs = Date.now() - tGemStart;
      await recordGeminiSuccess(resp.usageMetadata, params.tenant);
      rawJson = (resp.text ?? '{}').trim();
    } catch (err) {
      const safeErr = await recordGeminiFailure(err, params.tenant);
      throw new Error(safeErr);
    }

    const data = parseGeminiJsonSafe<{
      replyText?: string;
      shouldAttachStructuredCard?: boolean;
      decision?: string | null;
      expectedDirection?: string | null;
      buyConfidencePct?: number | null;
      sellConfidencePct?: number | null;
      bestDirection?: string | null;
      marketRegime?: string | null;
      lateEntryDetected?: boolean | null;
      expired?: boolean;
      asset?: string | null;
      timeframe?: string | null;
      entryWindowBrt?: string | null;
      expirationDuration?: string | null;
      expirationOptionsM1?: string[] | null;
      exitWindowBrt?: string | null;
      timeRemainingToEntry?: string | null;
      signalValidity?: string | null;
      entryPrice?: string | null;
      targetPrice?: string | null;
      stopLoss?: string | null;
      technicalConfidence?: number | null;
      reason?: string | null;
      riskWarning?: string | null;
      entryCondition?: string | null;
      cancellationCondition?: string | null;
      nextAction?: string | null;
    }>(rawJson, {
      replyText: rawJson && !rawJson.startsWith('{') ? rawJson : undefined,
      shouldAttachStructuredCard: false,
      expired: false,
    });

    let analysis: ChartAnalysisResult | undefined;
    if (data.shouldAttachStructuredCard && data.decision) {
      const rawDec = data.expired ? 'SINAL_EXPIRADO' : normalizeDecisionValue(data.decision);
      const rawDir = normalizeExpectedDirection(data.expectedDirection);
      const chatAsset = data.asset ?? targetAsset ?? null;
      const chatTf = data.timeframe ?? targetTimeframe ?? null;

      const chatPolicy = evaluateDecisionAndConfidencePolicy({
        decision: rawDec,
        expectedDirection: rawDir,
        buyConfidencePct: data.buyConfidencePct ?? prevAnalysis?.buyConfidencePct ?? null,
        sellConfidencePct: data.sellConfidencePct ?? prevAnalysis?.sellConfidencePct ?? null,
        bestDirection: data.bestDirection ?? prevAnalysis?.bestDirection ?? null,
        technicalConfidence: data.technicalConfidence ?? prevAnalysis?.technicalConfidence ?? null,
        analysisQuality: rawDec === 'AGUARDAR' ? 'MODERADA' : (prevAnalysis?.analysisQuality ?? 'MODERADA'),
        waitCategory: rawDec === 'AGUARDAR' ? (prevAnalysis?.waitCategory ?? 'AGUARDAR_CONFIRMACAO') : null,
        marketRegime: data.marketRegime ?? prevAnalysis?.marketRegime ?? null,
        lateEntryDetected: Boolean(data.lateEntryDetected),
        favorableEvidences: prevAnalysis?.favorableEvidences ?? [],
        contraryEvidences: prevAnalysis?.contraryEvidences ?? [],
        reason: data.reason || data.replyText || 'Reavaliação concluída.',
        riskWarning: data.riskWarning ?? data.cancellationCondition ?? null,
        entryTrigger: prevAnalysis?.entryTrigger ?? null,
        nextAction: data.nextAction ?? null,
      });

      const validatedChat = validateSignalConsistency({
        decision: chatPolicy.decision,
        expectedDirection: chatPolicy.expectedDirection,
        entryWindowBrt: chatPolicy.decision === 'COMPRA' || chatPolicy.decision === 'VENDA' ? (data.entryWindowBrt ?? null) : null,
        exitWindowBrt: chatPolicy.decision === 'COMPRA' || chatPolicy.decision === 'VENDA' ? (data.exitWindowBrt ?? null) : null,
        expirationDuration: chatPolicy.decision === 'COMPRA' || chatPolicy.decision === 'VENDA' ? (data.expirationDuration ?? null) : null,
        nowTimeBrt: timeSync.shortTimeBrt,
        nowUnixMs: timeSync.unixMs,
        asset: chatAsset,
        timeframe: chatTf,
        reason: chatPolicy.reason,
        riskWarning: data.riskWarning ?? data.cancellationCondition ?? null,
      });

      if (
        prevAnalysis &&
        (prevAnalysis.decision === 'COMPRA' || prevAnalysis.decision === 'VENDA') &&
        (validatedChat.decision === 'SINAL_EXPIRADO' || validatedChat.decision === 'AGUARDAR')
      ) {
        await invalidatePendingSignal({
          asset: prevAnalysis.asset,
          entryTimeBrt: prevAnalysis.entryWindowBrt,
          reason: validatedChat.reason,
          tenant: params.tenant,
        }).catch(() => {});
      }

      const base: Omit<ChartAnalysisResult, 'formattedReport'> = {
        decision: validatedChat.decision,
        expectedDirection: validatedChat.expectedDirection,
        expired: Boolean(data.expired || validatedChat.decision === 'SINAL_EXPIRADO'),
        asset: chatAsset,
        normalizedSymbol: liveQuote?.available ? liveQuote.symbol : null,
        timeframe: chatTf,
        analysisTimeBrt: `${timeSync.dateBrt} ${timeSync.timeBrt}`,
        photoReceivedAtBrt: lastImageMsg?.photoCapturedAtBrt || `${timeSync.dateBrt} ${timeSync.timeBrt}`,
        entryWindowBrt: validatedChat.entryWindowBrt,
        expirationDuration: validatedChat.expirationDuration,
        expirationOptionsM1: Array.isArray(data.expirationOptionsM1) ? data.expirationOptionsM1 : undefined,
        exitWindowBrt: validatedChat.exitWindowBrt,
        timeRemainingToEntry: data.timeRemainingToEntry ?? null,
        signalValidity: data.signalValidity ?? validatedChat.expirationDuration ?? null,
        entryPrice: data.entryPrice ?? null,
        targetPrice: data.targetPrice ?? null,
        stopLoss: data.stopLoss ?? null,
        technicalConfidence: chatPolicy.technicalConfidence,
        buyConfidencePct: chatPolicy.buyConfidencePct,
        sellConfidencePct: chatPolicy.sellConfidencePct,
        bestDirection: chatPolicy.bestDirection,
        confidenceDisclaimer: CONFIDENCE_DISCLAIMER,
        marketRegime: chatPolicy.marketRegime,
        lateEntryDetected: chatPolicy.lateEntryDetected,
        recommendedWaitMinutes: chatPolicy.recommendedWaitMinutes,
        analysisQuality: chatPolicy.analysisQuality,
        waitCategory: chatPolicy.waitCategory ?? validatedChat.waitCategory ?? null,
        reason: validatedChat.reason,
        riskWarning: data.riskWarning ?? data.cancellationCondition ?? null,
        entryCondition: data.entryCondition ?? null,
        cancellationCondition: data.cancellationCondition ?? data.riskWarning ?? null,
        nextAction: validatedChat.nextAction ?? chatPolicy.nextAction ?? data.nextAction ?? null,
        dataFreshnessStatus: quoteCtx.freshnessStatus,
        dataFreshnessNote: quoteCtx.freshnessNote,
        visibleIndicators: prevAnalysis?.visibleIndicators ?? [],
      };
      analysis = {
        ...base,
        formattedReport: buildFormattedReport(base),
      };
      if (!analysis.expired && (analysis.decision === 'COMPRA' || analysis.decision === 'VENDA')) {
        await recordEmittedSignal({
          analysis,
          marketQuote: liveQuote,
          origin: 'LIVE_AI',
          tenant: params.tenant,
        }).catch(() => {});
      }
    }

    const totalMs = Date.now() - tStart;
    await recordLatency('text', totalMs, params.tenant);

    return {
      replyText: data.replyText || (analysis ? analysis.formattedReport : 'Não foi possível gerar resposta.'),
      analysis,
      marketQuote: liveQuote,
      timeSync,
      timings: { totalMs, timeSyncMs, quoteMs, geminiMs },
    };
  })();

  inFlightChats.set(chatKey, execPromise);
  try {
    const bundle = await execPromise;
    chatCache.set(chatKey, { expiresAt: Date.now() + CHAT_CACHE_TTL_MS, result: bundle });
    if (chatCache.size > 40) {
      const oldest = chatCache.keys().next().value;
      if (oldest) chatCache.delete(oldest);
    }
    return bundle;
  } finally {
    inFlightChats.delete(chatKey);
  }
}
