import crypto from 'node:crypto';
import { GoogleGenAI, ThinkingLevel, Type, type Content, type Part } from '@google/genai';
import type {
  BrasiliaTimeSync,
  ChartAnalysisResult,
  ChatMessage,
  MarketQuote,
} from '../shared/types.ts';
import { fetchMarketQuote, normalizeAssetQuery } from './marketData.ts';
import { recordEmittedSignal } from './signalValidator.ts';
import { getSynchronizedBrasiliaTime } from './timeService.ts';
import {
  assertNotInRateLimitCooldown,
  GEMINI_MODEL,
  recordCacheHit,
  recordDeduplicatedRequest,
  recordGeminiFailure,
  recordGeminiSuccess,
  recordLatency,
  sanitizeErrorMessage,
} from './usageTracker.ts';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
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
): string {
  return crypto
    .createHash('sha256')
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
    entryWindowBrt: { type: Type.STRING, nullable: true, description: 'Horário futuro de entrada em HH:MM BRT' },
    expirationDuration: { type: Type.STRING, nullable: true, description: 'Tempo de expiração compatível com o timeframe (para M1 use ex: 1 min, 2 min ou 3 min)' },
    exitWindowBrt: { type: Type.STRING, nullable: true, description: 'Horário de vencimento em HH:MM BRT posterior à entrada' },
    timeRemainingToEntry: { type: Type.STRING, nullable: true },
    signalValidity: { type: Type.STRING, nullable: true },
    entryPrice: { type: Type.STRING, nullable: true },
    targetPrice: { type: Type.STRING, nullable: true },
    stopLoss: { type: Type.STRING, nullable: true },
    technicalConfidence: { type: Type.NUMBER, nullable: true },
    reason: { type: Type.STRING, description: 'JUSTIFICATIVA técnica objetiva considerando contexto de 30-60 candles, tendência, estrutura, S/R e gatilho' },
    riskWarning: { type: Type.STRING, nullable: true, description: 'RISCO: evidências contrárias e o que pode invalidar a previsão' },
    favorableEvidences: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Evidências técnicas objetivas a favor da operação ou direção',
    },
    contraryEvidences: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Evidências contrárias ou pontos de atenção no gráfico',
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

function parseMinutesOfDay(text?: string | null): number | null {
  if (!text) return null;
  const m = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function formatMinutesToBrt(totalMin: number): string {
  const m = ((totalMin % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm} BRT`;
}

function normalizeDecisionValue(raw?: string | null): ChartAnalysisResult['decision'] {
  const up = (raw || '').toUpperCase().trim();
  if (up === 'COMPRA' || up === 'CALL' || up.includes('COMPRA')) return 'COMPRA';
  if (up === 'VENDA' || up === 'PUT' || up.includes('VENDA')) return 'VENDA';
  if (up === 'SINAL_EXPIRADO' || up.includes('EXPIRAD')) return 'SINAL_EXPIRADO';
  return 'AGUARDAR';
}

function normalizeExpectedDirection(
  raw?: string | null,
): 'SUBIDA' | 'QUEDA' | 'INDEFINIDA' {
  const up = (raw || '').toUpperCase().trim();
  if (up === 'SUBIDA' || up.includes('SUBID') || up.includes('ALTA')) return 'SUBIDA';
  if (up === 'QUEDA' || up.includes('QUED') || up.includes('BAIXA')) return 'QUEDA';
  return 'INDEFINIDA';
}

function normalizeAnalysisQuality(
  raw?: string | null,
  decision?: ChartAnalysisResult['decision'],
): 'FORTE' | 'MODERADA' | 'INSUFICIENTE' {
  const up = (raw || '').toUpperCase().trim();
  if (decision === 'AGUARDAR' || decision === 'SINAL_EXPIRADO') {
    return up === 'INSUFICIENTE' || up === 'MODERADA' ? up : 'INSUFICIENTE';
  }
  if (up.includes('FORTE')) return 'FORTE';
  if (up.includes('MODERAD')) return 'MODERADA';
  return 'MODERADA';
}

function normalizeWaitCategory(
  raw?: string | null,
  decision?: ChartAnalysisResult['decision'],
): ChartAnalysisResult['waitCategory'] {
  if (decision !== 'AGUARDAR') return null;
  const up = (raw || '').toUpperCase().trim();
  if (up.includes('ILEGIV') || up.includes('ILEGÍV') || up.includes('QUALIDADE')) return 'IMAGEM_ILEGIVEL';
  if (up.includes('LATERAL') || up.includes('CONSOLID')) return 'MERCADO_LATERAL';
  if (up.includes('CONTRADIT')) return 'SINAIS_CONTRADITORIOS';
  return 'AGUARDAR_CONFIRMACAO';
}

function validateSignalConsistency(params: {
  decision: ChartAnalysisResult['decision'];
  expectedDirection: 'SUBIDA' | 'QUEDA' | 'INDEFINIDA';
  entryWindowBrt: string | null;
  exitWindowBrt: string | null;
  expirationDuration: string | null;
  nowTimeBrt: string;
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
} {
  let { decision, expectedDirection, entryWindowBrt, exitWindowBrt, expirationDuration, reason } = params;

  if (decision === 'SINAL_EXPIRADO' || decision === 'AGUARDAR') {
    return {
      decision,
      expectedDirection: decision === 'AGUARDAR' && expectedDirection !== 'INDEFINIDA' ? expectedDirection : 'INDEFINIDA',
      entryWindowBrt: null,
      exitWindowBrt: null,
      expirationDuration: null,
      reason,
      nextAction: null,
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
      nextAction: 'Não operar até haver alinhamento claro entre tendência, candles e direção.',
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
      nextAction: 'Não operar até haver alinhamento claro entre tendência, candles e direção.',
    };
  }

  expectedDirection = decision === 'COMPRA' ? 'SUBIDA' : 'QUEDA';

  // 2. Ensure entry time is not clearly in the past relative to synchronized Brasília clock (-2 min tolerance for M1 boundary ticks)
  const nowMin = parseMinutesOfDay(params.nowTimeBrt);
  const entryMin = parseMinutesOfDay(entryWindowBrt);
  const exitMin = parseMinutesOfDay(exitWindowBrt);

  if (nowMin !== null && entryMin !== null) {
    let deltaEntry = entryMin - nowMin;
    if (deltaEntry < -720) deltaEntry += 1440; // midnight rollover guard
    if (deltaEntry > 720) deltaEntry -= 1440;
    if (deltaEntry < -2) {
      return {
        decision: 'AGUARDAR',
        expectedDirection: 'INDEFINIDA',
        entryWindowBrt: null,
        exitWindowBrt: null,
        expirationDuration: null,
        reason: `Sinal retido para proteção de capital: o horário de entrada (${entryWindowBrt}) já está no passado em relação ao horário atual de Brasília (${params.nowTimeBrt}).`,
        nextAction: 'Aguardar o próximo candle ou enviar nova fotografia atualizada.',
      };
    }
  }

  // 3. Ensure expiration / exit window is strictly after entry window when both are HH:MM
  if (entryMin !== null && exitMin !== null) {
    let deltaExit = exitMin - entryMin;
    if (deltaExit <= -720) deltaExit += 1440;
    if (deltaExit <= 0) {
      return {
        decision: 'AGUARDAR',
        expectedDirection: 'INDEFINIDA',
        entryWindowBrt: null,
        exitWindowBrt: null,
        expirationDuration: null,
        reason: `Sinal retido por inconsistência no vencimento (${exitWindowBrt} não é posterior à entrada ${entryWindowBrt}).`,
        nextAction: 'Aguardar nova formação com janela de expiração coerente.',
      };
    }
  }

  if (!expirationDuration) {
    const tfNorm = (params.timeframe || '').toLowerCase();
    expirationDuration = /^(1m|m1|1\s*min)/.test(tfNorm) || !tfNorm ? '1 min' : '5 min';
  }
  if (nowMin !== null && !entryWindowBrt) {
    entryWindowBrt = formatMinutesToBrt(nowMin + 1);
  }
  const resolvedEntryMin = parseMinutesOfDay(entryWindowBrt);
  if (resolvedEntryMin !== null && !exitWindowBrt) {
    const durMatch = expirationDuration.match(/(\d+)/);
    const expMins = durMatch ? Math.max(1, Math.min(60, Number(durMatch[1]))) : 1;
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

function buildFormattedReport(
  raw: Omit<ChartAnalysisResult, 'formattedReport'>,
): string {
  if (raw.expired || raw.decision === 'SINAL_EXPIRADO') {
    return [
      'SINAL EXPIRADO — NÃO ENTRAR NESTA CONDIÇÃO. AGUARDAR NOVA OPORTUNIDADE.',
      '',
      `ATIVO: ${raw.asset || 'Não identificado'}`,
      `TIMEFRAME: ${raw.timeframe || 'Não informado'}`,
      `HORÁRIO DA ANÁLISE: ${raw.analysisTimeBrt} — Brasília`,
      raw.analysisQuality ? `QUALIDADE DA ANÁLISE: ${raw.analysisQuality}` : null,
      `JUSTIFICATIVA: ${raw.reason}`,
      `RISCO: ${raw.riskWarning || 'Entrada tardia reduz a assimetria da operação e aumenta risco de perda.'}`,
      raw.nextAction ? `PRÓXIMA AÇÃO: ${raw.nextAction}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (raw.decision === 'AGUARDAR') {
    return [
      `DECISÃO: AGUARDAR (${formatWaitCategoryLabel(raw.waitCategory)}).`,
      'DIREÇÃO ESPERADA: INDEFINIDA (AGUARDAR CONFIRMAÇÃO)',
      raw.asset ? `ATIVO: ${raw.asset}` : null,
      `TIMEFRAME: ${raw.timeframe || 'Não informado'}`,
      `HORÁRIO DA ANÁLISE: ${raw.analysisTimeBrt} — Brasília`,
      raw.analysisQuality ? `QUALIDADE DA ANÁLISE: ${raw.analysisQuality}` : null,
      '',
      `JUSTIFICATIVA:\n${raw.reason}`,
      raw.favorableEvidences && raw.favorableEvidences.length > 0
        ? `\nEVIDÊNCIAS FAVORÁVEIS:\n- ${raw.favorableEvidences.join('\n- ')}`
        : null,
      raw.contraryEvidences && raw.contraryEvidences.length > 0
        ? `\nEVIDÊNCIAS CONTRÁRIAS:\n- ${raw.contraryEvidences.join('\n- ')}`
        : null,
      '',
      `RISCO:\n${raw.riskWarning || 'Operar sem confirmação clara ou contra suporte/resistência próximo eleva o risco de perda.'}`,
      raw.entryTrigger ? `\nO QUE FALTA PARA ENTRADA: ${raw.entryTrigger}` : null,
      raw.nextAction ? `PRÓXIMA AÇÃO: ${raw.nextAction}` : null,
      raw.clarificationQuestion ? `PERGUNTA: ${raw.clarificationQuestion}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  const decisionLabel = raw.decision === 'COMPRA' ? 'COMPRA (CALL)' : 'VENDA (PUT)';
  const dirLabel = raw.expectedDirection === 'SUBIDA' || raw.decision === 'COMPRA' ? 'SUBIDA' : 'QUEDA';

  return [
    `DECISÃO: ${decisionLabel}.`,
    `DIREÇÃO ESPERADA: ${dirLabel}.`,
    '',
    `ATIVO: ${raw.asset || 'Não identificado'}`,
    `HORÁRIO DE ENTRADA: ${raw.entryWindowBrt || 'Aguardar próximo candle (Brasília)'}`,
    `TIMEFRAME: ${raw.timeframe || 'Não informado'}`,
    `EXPIRAÇÃO: ${raw.expirationDuration || 'Compatível com 1 a 3 candles de M1'}`,
    `HORÁRIO DE VENCIMENTO: ${raw.exitWindowBrt || 'Fechamento da expiração (Brasília)'}`,
    raw.entryPrice ? `REGIÃO DE ENTRADA: ${raw.entryPrice}` : null,
    raw.stopLoss ? `INVALIDAÇÃO / STOP: ${raw.stopLoss}` : null,
    raw.targetPrice ? `ALVO TÉCNICO: ${raw.targetPrice}` : null,
    `QUALIDADE DA ANÁLISE: ${raw.analysisQuality || 'MODERADA'}`,
    `CONFIANÇA TÉCNICA: ${raw.technicalConfidence ?? 65}/100`,
    '',
    `JUSTIFICATIVA:\n${raw.reason}`,
    raw.favorableEvidences && raw.favorableEvidences.length > 0
      ? `\nEVIDÊNCIAS FAVORÁVEIS:\n- ${raw.favorableEvidences.join('\n- ')}`
      : null,
    raw.contraryEvidences && raw.contraryEvidences.length > 0
      ? `\nEVIDÊNCIAS CONTRÁRIAS / ATENÇÃO:\n- ${raw.contraryEvidences.join('\n- ')}`
      : null,
    '',
    `RISCO:\n${raw.riskWarning || raw.cancellationCondition || 'Reversão brusca ou rejeição em nível próximo de suporte/resistência pode invalidar a previsão.'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function runChartAnalysisUncached(params: {
  imageDataUrl: string;
  userMessage?: string;
  photoReceivedAtBrt?: string;
  history?: ChatMessage[];
}): Promise<AnalysisBundle> {
  const tStart = Date.now();
  await assertNotInRateLimitCooldown();
  const ai = getGeminiClient();
  const { mimeType, data } = parseBase64Image(params.imageDataUrl);
  const imagePart = { inlineData: { mimeType, data } };

  // Extract hints from caption or previous conversation asset to skip Pass 1 when possible
  const lastConvAsset = [...(params.history || [])]
    .reverse()
    .find((m) => m.analysis?.asset)?.analysis?.asset;
  const lastConvTf = [...(params.history || [])]
    .reverse()
    .find((m) => m.analysis?.timeframe)?.analysis?.timeframe;
  const hints = extractHintsFromText(params.userMessage, lastConvAsset, lastConvTf);

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
    // Asset already known from caption/context: run time sync + live quote in parallel!
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
      await recordGeminiSuccess(extractResp.usageMetadata);

      const extracted = JSON.parse((extractResp.text ?? '{}').trim()) as VisualExtraction;
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
          technicalConfidence: null,
          analysisQuality: 'INSUFICIENTE',
          waitCategory: 'IMAGEM_ILEGIVEL',
          favorableEvidences: [],
          contraryEvidences: [reason],
          entryTrigger: 'Enviar uma nova fotografia focada nos últimos 30 a 60 candles e no eixo de preços.',
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
        await recordLatency('image', totalMs);
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
      const safeErr = await recordGeminiFailure(err);
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
    'Analista técnico especializado em leitura de fluxo de candles e price action para opções binárias (PT-BR).',
    'LÓGICA OBRIGATÓRIA DE OPÇÕES BINÁRIAS (NUNCA INVERTER): COMPRA (CALL) = previsão de SUBIDA (preço fecha ACIMA da entrada no vencimento). VENDA (PUT) = previsão de QUEDA (preço fecha ABAIXO da entrada no vencimento).',
    'PROTEÇÃO DE CAPITAL SEM EXCESSO DE AGUARDAR: nunca force entradas sem vantagem estatística visual, mas NÃO devolva AGUARDAR por excesso de perfeccionismo quando o gráfico apresenta leitura válida.',
    'LEITURA ESPECÍFICA DE M1 (analise os últimos 30 a 60 candles visíveis, nunca apenas o último candle isolado): avalie (1) direção e força da tendência de curto prazo; (2) sequência de máximas e mínimas (topos e fundos ascendentes ou descendentes); (3) corpos e pavios dos candles; (4) suportes e resistências próximos; (5) rompimentos consistentes e falsos rompimentos; (6) rejeições de preço; (7) pullbacks em zonas rompidas e continuações; (8) engolfo, martelo, estrela cadente, doji e pin bar somente quando claramente visíveis.',
    'REGRAS ANTI-FALSO-AGUARDAR NO M1: NÃO rejeite gráficos apenas porque (a) o mercado está em movimento ativo/forte sem ter feito pullback ainda, (b) os candles possuem variação natural de tamanho, (c) não existem indicadores técnicos na tela (price action puro é totalmente analisável), (d) um único candle isolado não confirmou sozinho se o contexto dos 30-60 candles já confirma, (e) a tendência tem pequenas oscilações e não é uma reta perfeita, ou (f) se trata de ativo OTC cujo preço próprio difere do feed externo.',
    'NÃO exija que todos os critérios estejam perfeitos simultaneamente: pese evidências favoráveis vs contrárias e separe nitidez da IMAGEM de qualidade da OPORTUNIDADE (analysisQuality: FORTE, MODERADA ou INSUFICIENTE).',
    'Quando houver setup FORTE ou MODERADO claro (ex.: tendência definida com topos/fundos alinhados, pullback em S/R rompido com retomada, rompimento consistente com corpo forte, ou falso rompimento / rejeição dupla em S/R com candle de confirmação), emita COMPRA (CALL) ou VENDA (PUT) com expiração M1 (1 min, 2 min ou 3 min).',
    'Emita AGUARDAR apenas quando: (1) a imagem for realmente ilegível (IMAGEM_ILEGIVEL); (2) o mercado estiver em lateralidade/consolidação horizontal (range preso entre topo e fundo próximos, sem rompimento definido ou com candles alternando sem direção dominante -> OBRIGATORIAMENTE decision="AGUARDAR" e waitCategory="MERCADO_LATERAL"); (3) houver sinais fortemente contraditórios (SINAIS_CONTRADITORIOS, ex.: candle de alta batendo direto em resistência forte com pavios de rejeição ou velas conflitantes grandes); ou (4) falso rompimento/S-R ainda sem candle de confirmação (AGUARDAR_CONFIRMACAO), explicando exatamente em entryTrigger o que falta acontecer para entrar.',
    'PROIBIDO: recomendar martingale, dobrar mão, aumentar frequência após perda, prometer lucro, inventar porcentagem de assertividade/win rate ou citar indicadores que não aparecem na foto.',
  ].join(' ');

  const decisionPrompt = [
    `BRASÍLIA AGORA: ${analysisNow.dateBrt} ${analysisNow.timeBrt} (${analysisNow.shortTimeBrt} BRT) | FOTO RECEBIDA: ${photoReceivedBrt}`,
    detectedAsset ? `ATIVO DETECTADO: ${detectedAsset}${isOtcChart ? ' (MERCADO OTC)' : ''}` : 'ATIVO: detectar na foto; se o código do ativo estiver cortado, ainda analise os candles normalmente se o gráfico estiver legível (asset=null).',
    detectedTimeframe ? `TIMEFRAME: ${detectedTimeframe}` : 'TIMEFRAME: detectar na foto (se candles de opções binárias sem legenda explícita, assuma leitura M1 se compatível).',
    params.userMessage ? `SOLICITAÇÃO DO USUÁRIO: "${params.userMessage}"` : null,
    isM1Context ? 'MODO M1 ATIVO: priorize contexto de 30-60 candles, estrutura de topos/fundos, S/R próximos, rompimentos/falsos rompimentos, rejeições e pullbacks. Se emitir sinal, use expirationDuration entre "1 min", "2 min" ou "3 min".' : null,
    `REFERÊNCIA DE MERCADO:\n${quoteCtx.contextText}`,
    'INSTRUÇÕES DE SAÍDA JSON:',
    '- COMPRA => expectedDirection="SUBIDA"; VENDA => expectedDirection="QUEDA".',
    '- Para COMPRA/VENDA: preencha analysisQuality ("FORTE" ou "MODERADA"), waitCategory=null, entryWindowBrt futuro (>= ' + analysisNow.shortTimeBrt + ' BRT, ex: próximo minuto ou minuto atual), expirationDuration ("1 min", "2 min" ou "3 min" em M1), exitWindowBrt posterior à entrada, favorableEvidences e contraryEvidences.',
    '- Para AGUARDAR: preencha analysisQuality="INSUFICIENTE" (ou "MODERADA" se aguardando só gatilho), waitCategory obrigatório (IMAGEM_ILEGIVEL | MERCADO_LATERAL | SINAIS_CONTRADITORIOS | AGUARDAR_CONFIRMACAO), entryTrigger descrevendo o gatilho exato que falta, favorableEvidences e contraryEvidences.',
    '- Se o gráfico estiver lateralizado/em range horizontal sem rompimento claro, NÃO emita COMPRA nem VENDA: retorne decision="AGUARDAR" e waitCategory="MERCADO_LATERAL".',
    '- NÃO marque SINAL_EXPIRADO em gráficos OTC apenas por diferença de cotação em relação ao mercado spot externo.',
  ]
    .filter(Boolean)
    .join('\n');

  let finalText = '{}';
  try {
    await assertNotInRateLimitCooldown();
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
    await recordGeminiSuccess(finalResp.usageMetadata);
    finalText = (finalResp.text ?? '{}').trim();
  } catch (err) {
    const safeErr = await recordGeminiFailure(err);
    throw new Error(safeErr);
  }

  const parsed = JSON.parse(finalText) as {
    decision?: string;
    expectedDirection?: string;
    analysisQuality?: string;
    waitCategory?: string | null;
    expired?: boolean;
    asset?: string | null;
    timeframe?: string | null;
    entryWindowBrt?: string | null;
    expirationDuration?: string | null;
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
  };

  let rawDecision = parsed.expired
    ? 'SINAL_EXPIRADO'
    : normalizeDecisionValue(parsed.decision);
  if (isOtcChart && rawDecision === 'SINAL_EXPIRADO') {
    rawDecision = 'AGUARDAR';
  }
  const rawDirection = normalizeExpectedDirection(parsed.expectedDirection);
  const finalAsset = parsed.asset ?? detectedAsset ?? null;
  const finalTimeframe = parsed.timeframe ?? detectedTimeframe ?? null;

  const validated = validateSignalConsistency({
    decision: rawDecision,
    expectedDirection: rawDirection,
    entryWindowBrt: parsed.entryWindowBrt ?? null,
    exitWindowBrt: parsed.exitWindowBrt ?? null,
    expirationDuration: parsed.expirationDuration ?? null,
    nowTimeBrt: analysisNow.shortTimeBrt,
    asset: finalAsset,
    timeframe: finalTimeframe,
    reason: parsed.reason || 'Análise técnica concluída com base nos candles visíveis.',
    riskWarning: parsed.riskWarning ?? parsed.cancellationCondition ?? null,
  });

  const normalizedQuality = normalizeAnalysisQuality(parsed.analysisQuality, validated.decision);
  const normalizedWaitCat = normalizeWaitCategory(parsed.waitCategory, validated.decision);
  const favorableList = Array.isArray(parsed.favorableEvidences)
    ? parsed.favorableEvidences.filter((x) => typeof x === 'string' && x.trim().length > 0)
    : [];
  const contraryList = Array.isArray(parsed.contraryEvidences)
    ? parsed.contraryEvidences.filter((x) => typeof x === 'string' && x.trim().length > 0)
    : [];

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
    exitWindowBrt: validated.exitWindowBrt,
    timeRemainingToEntry:
      validated.decision === 'COMPRA' || validated.decision === 'VENDA'
        ? (parsed.timeRemainingToEntry ?? null)
        : null,
    signalValidity:
      validated.decision === 'COMPRA' || validated.decision === 'VENDA'
        ? (parsed.signalValidity ?? validated.expirationDuration ?? null)
        : null,
    entryPrice: parsed.entryPrice ?? null,
    targetPrice: parsed.targetPrice ?? null,
    stopLoss: parsed.stopLoss ?? null,
    technicalConfidence:
      typeof parsed.technicalConfidence === 'number'
        ? Math.max(0, Math.min(100, Math.round(parsed.technicalConfidence)))
        : null,
    analysisQuality: normalizedQuality,
    waitCategory: normalizedWaitCat,
    favorableEvidences: favorableList,
    contraryEvidences: contraryList,
    entryTrigger:
      validated.decision === 'AGUARDAR'
        ? (parsed.entryTrigger ?? parsed.nextAction ?? 'Aguardar candle de confirmação alinhado à estrutura.')
        : null,
    reason: validated.reason,
    riskWarning: parsed.riskWarning ?? parsed.cancellationCondition ?? null,
    entryCondition: parsed.entryCondition ?? null,
    cancellationCondition: parsed.cancellationCondition ?? parsed.riskWarning ?? null,
    nextAction:
      validated.decision === 'AGUARDAR'
        ? (validated.nextAction ?? parsed.nextAction ?? parsed.entryTrigger ?? null)
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
    }).catch(() => {});
  }

  const totalMs = Date.now() - tStart;
  await recordLatency('image', totalMs);

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
}): Promise<AnalysisBundle> {
  const lastConvAsset = [...(params.history || [])]
    .reverse()
    .find((m) => m.analysis?.asset)?.analysis?.asset;
  const lastConvTf = [...(params.history || [])]
    .reverse()
    .find((m) => m.analysis?.timeframe)?.analysis?.timeframe;

  const cacheKey = computeAnalysisCacheKey(
    params.imageDataUrl,
    params.userMessage,
    lastConvAsset,
    lastConvTf,
  );

  // 1. Return exact cached result if still valid
  const cached = analysisCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    await recordCacheHit();
    return cached.result;
  }

  // 2. Deduplicate concurrent identical requests
  const existingPromise = inFlightAnalyses.get(cacheKey);
  if (existingPromise) {
    await recordDeduplicatedRequest();
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
}): Promise<ChatBundle> {
  const tStart = Date.now();
  const trimmedMsg = params.userMessage.trim();

  // Pure TypeScript fast path 1: Brasília time query (zero Gemini tokens)
  if (isPureTimeQuery(trimmedMsg)) {
    const tSync = Date.now();
    const timeSync = await getSynchronizedBrasiliaTime(true);
    const timeSyncMs = Date.now() - tSync;
    const totalMs = Date.now() - tStart;
    await recordLatency('text', totalMs);
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
      await recordLatency('text', totalMs);
      return {
        replyText: `${liveQuote.displayName}: ${liveQuote.price.toLocaleString('pt-BR', { maximumFractionDigits: 6 })} ${liveQuote.currency}${varTxt} — fonte ${liveQuote.provider} às ${liveQuote.fetchedAtBrt} BRT.`,
        marketQuote: liveQuote,
        timeSync,
        timings: { totalMs, timeSyncMs, quoteMs, geminiMs: 0 },
      };
    }
  }

  // Deduplicate and short-cache identical chat queries to avoid duplicate Gemini API usage
  const tailKey = params.messages
    .slice(-3)
    .map((m) => `${m.role}:${m.text.slice(0, 80)}`)
    .join('|');
  const chatKey = crypto
    .createHash('sha256')
    .update(`${trimmedMsg.toLowerCase()}|${targetAsset || ''}|${targetTimeframe || ''}|${tailKey}|${Boolean(lastImageMsg?.imageDataUrl)}`)
    .digest('hex');

  const cachedChat = chatCache.get(chatKey);
  if (cachedChat && cachedChat.expiresAt > Date.now()) {
    await recordCacheHit();
    return cachedChat.result;
  }

  const pendingChat = inFlightChats.get(chatKey);
  if (pendingChat) {
    await recordDeduplicatedRequest();
    return pendingChat;
  }

  const execPromise = (async (): Promise<ChatBundle> => {
    await assertNotInRateLimitCooldown();
    const ai = getGeminiClient();

  // Run timeSync (cached 60s) + live market quote (cached 15s) in parallel!
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
  const priorMessages =
    params.messages.length > 0 &&
    params.messages[params.messages.length - 1]?.role === 'user' &&
    params.messages[params.messages.length - 1]?.text.trim() === params.userMessage.trim()
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

  const prompt = [
    `BRASÍLIA AGORA: ${timeSync.dateBrt} ${timeSync.timeBrt} (${timeSync.shortTimeBrt} BRT)`,
    hasPhotoOrAnalysis
      ? `ÚLTIMA ANÁLISE:\n${prevAnalysis ? prevAnalysis.formattedReport : 'Fotografia enviada anteriormente.'}`
      : 'MODO CONVERSA DIRETA (nenhuma fotografia enviada ainda): responda dúvidas sobre mercado, análise técnica, gestão de risco ou ativos. Se houver cotação ao vivo abaixo, use os números reais. Só marque shouldAttachStructuredCard=true se houver análise anterior ou pedido explícito de sinal com dados suficientes; caso contrário mantenha shouldAttachStructuredCard=false.',
    `COTAÇÃO ATUAL:\n${quoteSection}`,
    `PERGUNTA: "${params.userMessage}"`,
    hasPhotoOrAnalysis
      ? 'Se o sinal anterior já passou da entrada, alvo, stop ou horário, responda "SINAL EXPIRADO — NÃO ENTRAR NESTA CONDIÇÃO. AGUARDAR NOVA OPORTUNIDADE." Marque shouldAttachStructuredCard=true apenas em reanálise/expiração formal.'
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
      expired: { type: Type.BOOLEAN },
      asset: { type: Type.STRING, nullable: true },
      timeframe: { type: Type.STRING, nullable: true },
      entryWindowBrt: { type: Type.STRING, nullable: true },
      expirationDuration: { type: Type.STRING, nullable: true },
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
    'Analista financeiro conversacional conservador (PT-BR). Lógica de opções binárias: COMPRA (CALL) = aposta em SUBIDA acima da entrada no vencimento; VENDA (PUT) = aposta em QUEDA abaixo da entrada no vencimento. Nunca inverta direções, nunca recomende martingale ou recuperação dobrando mão, nunca prometa lucro e priorize proteção do capital.',
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
    await recordGeminiSuccess(resp.usageMetadata);
    rawJson = (resp.text ?? '{}').trim();
  } catch (err) {
    const safeErr = await recordGeminiFailure(err);
    throw new Error(safeErr);
  }

  const data = JSON.parse(rawJson) as {
    replyText?: string;
    shouldAttachStructuredCard?: boolean;
    decision?: string | null;
    expectedDirection?: string | null;
    expired?: boolean;
    asset?: string | null;
    timeframe?: string | null;
    entryWindowBrt?: string | null;
    expirationDuration?: string | null;
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
  };

  let analysis: ChartAnalysisResult | undefined;
  if (data.shouldAttachStructuredCard && data.decision) {
    const rawDec = data.expired ? 'SINAL_EXPIRADO' : normalizeDecisionValue(data.decision);
    const rawDir = normalizeExpectedDirection(data.expectedDirection);
    const chatAsset = data.asset ?? targetAsset;
    const chatTf = data.timeframe ?? targetTimeframe;

    const validatedChat = validateSignalConsistency({
      decision: rawDec,
      expectedDirection: rawDir,
      entryWindowBrt: data.entryWindowBrt ?? null,
      exitWindowBrt: data.exitWindowBrt ?? null,
      expirationDuration: data.expirationDuration ?? null,
      nowTimeBrt: timeSync.shortTimeBrt,
      asset: chatAsset,
      reason: data.reason || data.replyText || 'Reavaliação concluída.',
      riskWarning: data.riskWarning ?? data.cancellationCondition ?? null,
    });

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
      exitWindowBrt: validatedChat.exitWindowBrt,
      timeRemainingToEntry: data.timeRemainingToEntry ?? null,
      signalValidity: data.signalValidity ?? validatedChat.expirationDuration ?? null,
      entryPrice: data.entryPrice ?? null,
      targetPrice: data.targetPrice ?? null,
      stopLoss: data.stopLoss ?? null,
      technicalConfidence:
        typeof data.technicalConfidence === 'number'
          ? Math.max(0, Math.min(100, Math.round(data.technicalConfidence)))
          : null,
      reason: validatedChat.reason,
      riskWarning: data.riskWarning ?? data.cancellationCondition ?? null,
      entryCondition: data.entryCondition ?? null,
      cancellationCondition: data.cancellationCondition ?? data.riskWarning ?? null,
      nextAction: validatedChat.nextAction ?? data.nextAction ?? null,
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
      }).catch(() => {});
    }
  }

  const totalMs = Date.now() - tStart;
  await recordLatency('text', totalMs);

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
