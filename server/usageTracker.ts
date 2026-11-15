import fs from 'node:fs/promises';
import path from 'node:path';
import { getTenantScopeKey, getTenantStorageDir } from './tenantRegistry.ts';
import { formatTimestampBrt } from './timeService.ts';

export const GEMINI_MODEL = 'gemini-3.1-flash-lite';

export function resolveGeminiApiKey(): string | null {
  const raw = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (!raw) return null;
  const unquoted = raw.replace(/^(['"])(.*)\1$/, '$2').trim();
  if (!unquoted || unquoted === 'MY_GEMINI_API_KEY') return null;
  return unquoted;
}

export interface TenantRef {
  uid: string;
  companyId: string;
}

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

function createEmptyStats(): UsageStats {
  return {
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
}

const tenantStatsMap = new Map<string, UsageStats>();
const loadedScopes = new Set<string>();

function resolveScope(tenant?: TenantRef): { key: string; filePath: string } {
  if (tenant?.uid && tenant?.companyId) {
    return {
      key: getTenantScopeKey(tenant.companyId, tenant.uid),
      filePath: path.join(getTenantStorageDir(tenant.companyId, tenant.uid), 'usage-stats.json'),
    };
  }
  const fallbackPath =
    process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME
      ? '/tmp/chartpulse-usage-stats.json'
      : path.resolve(process.cwd(), '.data', 'usage-stats.json');
  return { key: '_system', filePath: fallbackPath };
}

async function ensureLoaded(tenant?: TenantRef): Promise<{ stats: UsageStats; filePath: string }> {
  const { key, filePath } = resolveScope(tenant);
  let current = tenantStatsMap.get(key);
  if (!current) {
    current = createEmptyStats();
    tenantStatsMap.set(key, current);
  }
  if (!loadedScopes.has(key)) {
    loadedScopes.add(key);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<UsageStats>;
      Object.assign(current, parsed, { model: GEMINI_MODEL, thinkingLevel: 'MINIMAL' });
    } catch {
      // Start fresh for this tenant
    }
  }
  return { stats: current, filePath };
}

async function persistStats(filePath: string, stats: UsageStats): Promise<void> {
  try {
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

  for (const envName of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'TWELVE_DATA_API_KEY'] as const) {
    const secret = process.env[envName]?.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
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

export async function assertNotInRateLimitCooldown(tenant?: TenantRef): Promise<void> {
  const { stats } = await ensureLoaded(tenant);
  const now = Date.now();
  if (stats.cooldownUntilMs > now) {
    const waitSec = Math.max(1, Math.ceil((stats.cooldownUntilMs - now) / 1000));
    throw new Error(
      `Limite de requisições da API Gemini atingido (429). Aguarde ${waitSec}s antes de tentar novamente (${stats.cooldownUntilBrt} BRT).`,
    );
  }
}

export async function recordCacheHit(tenant?: TenantRef): Promise<void> {
  const { stats, filePath } = await ensureLoaded(tenant);
  stats.cacheHits += 1;
  await persistStats(filePath, stats);
}

export async function recordDeduplicatedRequest(tenant?: TenantRef): Promise<void> {
  const { stats, filePath } = await ensureLoaded(tenant);
  stats.deduplicatedRequests += 1;
  await persistStats(filePath, stats);
}

export async function recordQuoteLookup(cacheHit: boolean, tenant?: TenantRef): Promise<void> {
  const { stats } = await ensureLoaded(tenant);
  if (cacheHit) {
    stats.quoteCacheHits += 1;
  } else {
    stats.quoteApiCalls += 1;
  }
}

export async function recordLatency(
  kind: 'image' | 'text',
  durationMs: number,
  tenant?: TenantRef,
): Promise<void> {
  const { stats, filePath } = await ensureLoaded(tenant);
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
  await persistStats(filePath, stats);
}

export async function recordGeminiSuccess(
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  },
  tenant?: TenantRef,
): Promise<void> {
  const { stats, filePath } = await ensureLoaded(tenant);
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

  await persistStats(filePath, stats);
}

export async function recordGeminiFailure(err: unknown, tenant?: TenantRef): Promise<string> {
  const { stats, filePath } = await ensureLoaded(tenant);
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
  await persistStats(filePath, stats);
  return userMessage;
}

export async function getUsageStats(
  tenant?: TenantRef,
): Promise<Omit<UsageStats, '_imageCount' | '_textCount'>> {
  const { stats } = await ensureLoaded(tenant);
  const apiKeyConfigured = Boolean(resolveGeminiApiKey());
  const { _imageCount: _ic, _textCount: _tc, ...publicStats } = stats;
  return {
    ...publicStats,
    apiKeyConfigured,
  };
}
