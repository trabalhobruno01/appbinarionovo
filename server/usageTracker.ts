import fs from 'node:fs/promises';
import path from 'node:path';
import { formatTimestampBrt } from './timeService.ts';

export const GEMINI_MODEL = 'gemini-3.1-flash-lite';

export interface UsageStats {
  model: string;
  thinkingLevel: string;
  apiKeyConfigured: boolean;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  rateLimitErrors429: number;
  cacheHits: number;
  deduplicatedRequests: number;
  quoteApiCalls: number;
  quoteCacheHits: number;
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
  avgResponseMs: number;
  avgImageAnalysisMs: number;
  avgTextChatMs: number;
  lastImageAnalysisMs: number | null;
  lastTextChatMs: number | null;
  lastCallAtBrt: string | null;
  lastError: string | null;
  cooldownUntilMs: number;
  cooldownUntilBrt: string | null;
  _imageCount: number;
  _textCount: number;
}

const stats: UsageStats = {
  model: GEMINI_MODEL,
  thinkingLevel: 'MINIMAL',
  apiKeyConfigured: false,
  totalCalls: 0,
  successfulCalls: 0,
  failedCalls: 0,
  rateLimitErrors429: 0,
  cacheHits: 0,
  deduplicatedRequests: 0,
  quoteApiCalls: 0,
  quoteCacheHits: 0,
  promptTokens: 0,
  candidatesTokens: 0,
  totalTokens: 0,
  avgResponseMs: 0,
  avgImageAnalysisMs: 0,
  avgTextChatMs: 0,
  lastImageAnalysisMs: null,
  lastTextChatMs: null,
  lastCallAtBrt: null,
  lastError: null,
  cooldownUntilMs: 0,
  cooldownUntilBrt: null,
  _imageCount: 0,
  _textCount: 0,
};

let loaded = false;

function getStatsFilePath(): string {
  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return '/tmp/chartpulse-usage-stats.json';
  }
  return path.resolve(process.cwd(), '.data', 'usage-stats.json');
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(getStatsFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<UsageStats>;
    Object.assign(stats, parsed, { model: GEMINI_MODEL, thinkingLevel: 'MINIMAL' });
  } catch {
    // Start fresh
  }
}

async function persistStats(): Promise<void> {
  try {
    const filePath = getStatsFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(stats, null, 2), 'utf-8');
  } catch {
    // Non-fatal
  }
}

export function sanitizeErrorMessage(raw: string): string {
  let out = raw
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[CHAVE_PROTEGIDA]')
    .replace(/AQ\.[0-9A-Za-z._-]{16,}/g, '[CHAVE_PROTEGIDA]')
    .replace(/Bearer\s+[0-9A-Za-z._-]{12,}/gi, 'Bearer [CHAVE_PROTEGIDA]')
    .replace(/([?&](?:key|apikey|api_key)=)[^&\s]+/gi, '$1[CHAVE_PROTEGIDA]');

  for (const envName of ['GEMINI_API_KEY', 'TWELVE_DATA_API_KEY'] as const) {
    const secret = process.env[envName]?.trim();
    if (secret && secret.length >= 8 && secret !== 'MY_GEMINI_API_KEY') {
      out = out.split(secret).join('[CHAVE_PROTEGIDA]');
    }
  }
  return out;
}

export function extractRetryDelayMs(errorMessage: string): number {
  const secMatch =
    errorMessage.match(/retry\s*(?:in|after)?\s*([\d.]+)\s*s/i) ||
    errorMessage.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  if (secMatch) {
    const sec = Number(secMatch[1]);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.min(300_000, Math.ceil(sec * 1000));
    }
  }
  return 60_000;
}

export async function assertNotInRateLimitCooldown(): Promise<void> {
  await ensureLoaded();
  const now = Date.now();
  if (stats.cooldownUntilMs > now) {
    const waitSec = Math.max(1, Math.ceil((stats.cooldownUntilMs - now) / 1000));
    throw new Error(
      `Limite de requisições da API Gemini atingido (429). Aguarde ${waitSec}s antes de tentar novamente (${stats.cooldownUntilBrt} BRT).`,
    );
  }
}

export async function recordCacheHit(): Promise<void> {
  await ensureLoaded();
  stats.cacheHits += 1;
  await persistStats();
}

export async function recordDeduplicatedRequest(): Promise<void> {
  await ensureLoaded();
  stats.deduplicatedRequests += 1;
  await persistStats();
}

export async function recordQuoteLookup(cacheHit: boolean): Promise<void> {
  await ensureLoaded();
  if (cacheHit) {
    stats.quoteCacheHits += 1;
  } else {
    stats.quoteApiCalls += 1;
  }
}

export async function recordLatency(kind: 'image' | 'text', durationMs: number): Promise<void> {
  await ensureLoaded();
  const ms = Math.max(0, Math.round(durationMs));
  if (kind === 'image') {
    const totalPrev = stats.avgImageAnalysisMs * stats._imageCount;
    stats._imageCount += 1;
    stats.avgImageAnalysisMs = Math.round((totalPrev + ms) / stats._imageCount);
    stats.lastImageAnalysisMs = ms;
  } else {
    const totalPrev = stats.avgTextChatMs * stats._textCount;
    stats._textCount += 1;
    stats.avgTextChatMs = Math.round((totalPrev + ms) / stats._textCount);
    stats.lastTextChatMs = ms;
  }
  const combinedCount = stats._imageCount + stats._textCount;
  if (combinedCount > 0) {
    stats.avgResponseMs = Math.round(
      (stats.avgImageAnalysisMs * stats._imageCount + stats.avgTextChatMs * stats._textCount) /
        combinedCount,
    );
  }
  await persistStats();
}

export async function recordGeminiSuccess(usageMetadata?: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}): Promise<void> {
  await ensureLoaded();
  const now = Date.now();
  const brt = formatTimestampBrt(now);

  stats.totalCalls += 1;
  stats.successfulCalls += 1;
  stats.lastCallAtBrt = `${brt.dateBrt} ${brt.timeBrt}`;
  stats.lastError = null;
  stats.cooldownUntilMs = 0;
  stats.cooldownUntilBrt = null;

  if (usageMetadata) {
    stats.promptTokens += usageMetadata.promptTokenCount ?? 0;
    stats.candidatesTokens += usageMetadata.candidatesTokenCount ?? 0;
    stats.totalTokens += usageMetadata.totalTokenCount ?? 0;
  }

  await persistStats();
}

export async function recordGeminiFailure(err: unknown): Promise<string> {
  await ensureLoaded();
  const now = Date.now();
  const brt = formatTimestampBrt(now);
  const rawMessage = err instanceof Error ? err.message : String(err);
  const safeMsg = sanitizeErrorMessage(rawMessage);

  stats.totalCalls += 1;
  stats.failedCalls += 1;
  stats.lastCallAtBrt = `${brt.dateBrt} ${brt.timeBrt}`;

  const is429 =
    safeMsg.includes('429') ||
    safeMsg.includes('RESOURCE_EXHAUSTED') ||
    safeMsg.toLowerCase().includes('quota');

  const isKeyError =
    safeMsg.includes('API_KEY_INVALID') ||
    safeMsg.includes('PERMISSION_DENIED') ||
    safeMsg.includes('403') ||
    (safeMsg.includes('400') && safeMsg.toLowerCase().includes('api key'));

  const isNotFound = safeMsg.includes('404') || safeMsg.includes('NOT_FOUND');

  let userMessage: string;
  if (is429) {
    stats.rateLimitErrors429 += 1;
    const delayMs = extractRetryDelayMs(safeMsg);
    const untilMs = now + delayMs;
    const untilBrt = formatTimestampBrt(untilMs);
    stats.cooldownUntilMs = untilMs;
    stats.cooldownUntilBrt = `${untilBrt.timeBrt}`;
    const waitSec = Math.ceil(delayMs / 1000);
    userMessage = `Cota gratuita ou limite de requisições da API Gemini (${GEMINI_MODEL}) atingido (erro 429). Aguarde ${waitSec}s até ${untilBrt.timeBrt} BRT antes de enviar nova solicitação.`;
  } else if (isKeyError) {
    userMessage =
      'A chave GEMINI_API_KEY configurada no servidor é inválida ou não tem permissão para acessar a Gemini API.';
  } else if (isNotFound) {
    userMessage = `O modelo configurado (${GEMINI_MODEL}) não está disponível para esta chave da Gemini API no momento.`;
  } else {
    userMessage = safeMsg || 'Falha ao consultar a API Gemini.';
  }

  stats.lastError = userMessage;
  await persistStats();
  return userMessage;
}

export async function getUsageStats(): Promise<Omit<UsageStats, '_imageCount' | '_textCount'>> {
  await ensureLoaded();
  const key = process.env.GEMINI_API_KEY?.trim();
  const apiKeyConfigured = Boolean(key && key !== 'MY_GEMINI_API_KEY');
  const { _imageCount: _ic, _textCount: _tc, ...publicStats } = stats;
  return {
    ...publicStats,
    apiKeyConfigured,
  };
}
