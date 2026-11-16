import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CandlePoint,
  ChartAnalysisResult,
  DimensionStats,
  MarketQuote,
  SignalRecord,
  SignalStatus,
  SignalValidationSummary,
  TieRule,
  WalkForwardBacktestResult,
} from '../shared/types.ts';
import { fetchHistoricalCandles, fetchReferencePriceAtTime } from './marketData.ts';
import { getTenantScopeKey, getTenantStorageDir } from './tenantRegistry.ts';
import { formatTimestampBrt } from './timeService.ts';
import type { TenantRef } from './usageTracker.ts';

export const MIN_SAMPLE_FOR_STATS = 30;
export const DEFAULT_PAYOUT_PERCENT = 80;
export const DEFAULT_TIE_RULE: TieRule = 'REFUND';

const tenantLedgers = new Map<string, SignalRecord[]>();
const loadedLedgerScopes = new Set<string>();

function resolveLedgerScope(tenant?: TenantRef): { key: string; filePath: string } {
  if (tenant?.uid && tenant?.companyId) {
    return {
      key: getTenantScopeKey(tenant.companyId, tenant.uid),
      filePath: path.join(getTenantStorageDir(tenant.companyId, tenant.uid), 'signal-ledger.json'),
    };
  }
  const fallback =
    process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME
      ? '/tmp/chartpulse-signal-ledger.json'
      : path.resolve(process.cwd(), '.data', 'signal-ledger.json');
  return { key: '_system', filePath: fallback };
}

async function ensureLedgerLoaded(tenant?: TenantRef): Promise<{ ledger: SignalRecord[]; filePath: string }> {
  const { key, filePath } = resolveLedgerScope(tenant);
  let ledger = tenantLedgers.get(key);
  if (!ledger) {
    ledger = [];
    tenantLedgers.set(key, ledger);
  }
  if (!loadedLedgerScopes.has(key)) {
    loadedLedgerScopes.add(key);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as SignalRecord[];
      if (Array.isArray(parsed)) {
        const filtered = tenant?.uid
          ? parsed.filter(
              (r) =>
                (!r.ownerUid || r.ownerUid === tenant.uid) &&
                (!r.companyId || r.companyId === tenant.companyId),
            )
          : parsed;
        ledger.splice(0, ledger.length, ...filtered);
      }
    } catch {
      // Start empty for this tenant
    }
  }
  return { ledger, filePath };
}

async function persistLedger(filePath: string, ledger: SignalRecord[]): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(ledger.slice(0, 500), null, 2), 'utf-8');
  } catch {
    // Non-fatal
  }
}

export function computeBreakEvenWinRatePct(payoutPercent: number): number {
  const safePayout = Math.max(1, Math.min(100, payoutPercent));
  return Number(((100 / (100 + safePayout)) * 100).toFixed(2));
}

export function computeWilson95Pct(wins: number, total: number): { low: number; high: number } | null {
  if (total < MIN_SAMPLE_FOR_STATS) return null;
  const z = 1.96;
  const p = wins / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return {
    low: Number((Math.max(0, (center - margin) / denom) * 100).toFixed(2)),
    high: Number((Math.min(1, (center + margin) / denom) * 100).toFixed(2)),
  };
}

export function parseExpirationMinutes(expirationLabel?: string | null, timeframe?: string | null): number {
  const src = (expirationLabel || timeframe || '15m').toLowerCase().trim();
  const minMatch = src.match(/(\d+)\s*(?:min|m\b)/);
  if (minMatch) return Math.max(1, Math.min(1440, Number(minMatch[1])));
  const hourMatch = src.match(/(\d+)\s*(?:h|hora)/);
  if (hourMatch) return Math.max(60, Math.min(1440, Number(hourMatch[1]) * 60));
  const dayMatch = src.match(/(\d+)\s*(?:d|dia)/);
  if (dayMatch) return 1440;
  if (/^m(\d+)$/.test(src)) return Math.max(1, Number(src.slice(1)));
  if (/^h(\d+)$/.test(src)) return Math.max(60, Number(src.slice(1)) * 60);
  return 15;
}

function resolveBrtClockToMs(hhmmText: string | null | undefined, referenceMs: number, minAfterMs?: number): number | null {
  if (!hhmmText) return null;
  const m = hhmmText.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!m) return null;
  const targetH = Number(m[1]);
  const targetM = Number(m[2]);

  const refBrt = formatTimestampBrt(referenceMs);
  const [refH, refMin] = refBrt.shortTimeBrt.split(':').map(Number);
  let deltaMin = targetH * 60 + targetM - (refH * 60 + refMin);
  if (deltaMin < -720) deltaMin += 1440;
  if (deltaMin > 720) deltaMin -= 1440;

  const refMinuteStartMs = Math.floor(referenceMs / 60_000) * 60_000;
  let candidate = refMinuteStartMs + deltaMin * 60_000;
  if (minAfterMs !== undefined && candidate <= minAfterMs) {
    candidate = minAfterMs + 60_000;
  }
  return candidate;
}

function parseEntryPriceNumeric(entryPriceText: string | null | undefined, marketQuote: MarketQuote | null): {
  price: number | null;
  source: string;
} {
  if (marketQuote && marketQuote.available && marketQuote.price > 0) {
    return {
      price: marketQuote.price,
      source: `${marketQuote.provider} (referência ao vivo no momento do sinal)`,
    };
  }
  if (!entryPriceText) return { price: null, source: 'Sem preço numérico de referência' };

  // Parse unambiguous decimal/integer if no range ambiguity
  const cleaned = entryPriceText.replace(/[^\d.,-]/g, ' ').trim().split(/\s+/)[0];
  if (!cleaned) return { price: null, source: 'Sem preço numérico' };
  const normalized = cleaned.includes(',') && !cleaned.includes('.')
    ? cleaned.replace(',', '.')
    : cleaned.replace(/,/g, '');
  const num = Number(normalized);
  if (Number.isFinite(num) && num > 0) {
    return { price: num, source: 'Preço extraído da análise visual' };
  }
  return { price: null, source: 'Sem preço numérico' };
}

export function settleBinaryOutcome(params: {
  direction: 'COMPRA' | 'VENDA';
  entryPrice: number;
  expiryPrice: number;
  payoutPercent: number;
  tieRule: TieRule;
}): { status: 'GANHO' | 'PERDA' | 'EMPATE'; netReturnUnits: number } {
  const diff = params.expiryPrice - params.entryPrice;
  const tieEpsilon = Math.max(1e-9, Math.abs(params.entryPrice) * 1e-7);

  if (Math.abs(diff) <= tieEpsilon) {
    return {
      status: 'EMPATE',
      netReturnUnits: params.tieRule === 'REFUND' ? 0 : -1,
    };
  }

  const won =
    params.direction === 'COMPRA'
      ? params.expiryPrice > params.entryPrice
      : params.expiryPrice < params.entryPrice;

  if (won) {
    return {
      status: 'GANHO',
      netReturnUnits: Number((params.payoutPercent / 100).toFixed(4)),
    };
  }
  return {
    status: 'PERDA',
    netReturnUnits: -1,
  };
}

function getConfidenceBucket(confidence?: number | null): string {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return 'Não informado';
  if (confidence < 65) return '< 65%';
  if (confidence === 65) return '65%';
  if (confidence <= 70) return '66% - 70%';
  if (confidence <= 75) return '71% - 75%';
  if (confidence <= 80) return '76% - 80%';
  return '81% - 88%';
}

export async function recordEmittedSignal(params: {
  analysis: ChartAnalysisResult;
  marketQuote: MarketQuote | null;
  origin?: 'LIVE_AI' | 'DEMO_ACCOUNT';
  payoutPercent?: number;
  tieRule?: TieRule;
  imageRefHash?: string | null;
  tenant?: TenantRef & { projectId?: string };
}): Promise<SignalRecord | null> {
  const { analysis, marketQuote } = params;
  // Never register non-directional, below-threshold, or expired decisions as active trade signals
  if (analysis.expired || (analysis.decision !== 'COMPRA' && analysis.decision !== 'VENDA')) {
    return null;
  }
  if (!analysis.asset) return null;

  const { ledger, filePath } = await ensureLedgerLoaded(params.tenant);
  const nowMs = Date.now();
  const issuedBrt = formatTimestampBrt(nowMs);
  const expMinutes = parseExpirationMinutes(analysis.expirationDuration, analysis.timeframe);

  const entryTimeMs = resolveBrtClockToMs(analysis.entryWindowBrt, nowMs) ?? nowMs;
  const expiryTimeMs =
    resolveBrtClockToMs(analysis.exitWindowBrt, entryTimeMs, entryTimeMs) ??
    entryTimeMs + expMinutes * 60_000;

  const entryBrt = formatTimestampBrt(entryTimeMs);
  const expiryBrt = formatTimestampBrt(expiryTimeMs);
  const entryRef = parseEntryPriceNumeric(analysis.entryPrice, marketQuote);

  // Deduplicate identical signal emitted within 20 seconds for same asset/direction/entry within THIS tenant
  const duplicate = ledger.find(
    (s) =>
      s.asset === analysis.asset &&
      s.direction === analysis.decision &&
      Math.abs(s.issuedAtMs - nowMs) < 20_000,
  );
  if (duplicate) return duplicate;

  const record: SignalRecord = {
    id: `sig_${crypto.randomBytes(5).toString('hex')}`,
    ...(params.tenant?.uid ? { ownerUid: params.tenant.uid } : {}),
    ...(params.tenant?.companyId ? { companyId: params.tenant.companyId } : {}),
    ...(params.tenant?.projectId ? { projectId: params.tenant.projectId } : {}),
    origin: params.origin || 'LIVE_AI',
    asset: analysis.asset,
    normalizedSymbol: analysis.normalizedSymbol || marketQuote?.symbol || null,
    direction: analysis.decision,
    timeframe: analysis.timeframe || '15m',
    expirationLabel: analysis.expirationDuration || `${expMinutes} min`,
    expirationMinutes: expMinutes,
    issuedAtMs: nowMs,
    issuedAtBrt: `${issuedBrt.dateBrt} ${issuedBrt.timeBrt}`,
    entryTimeMs,
    entryTimeBrt: `${entryBrt.dateBrt} ${entryBrt.shortTimeBrt}`,
    expiryTimeMs,
    expiryTimeBrt: `${expiryBrt.dateBrt} ${expiryBrt.shortTimeBrt}`,
    entryPrice: entryRef.price,
    entryPriceSource: entryRef.source,
    expiryPrice: null,
    expiryPriceSource: null,
    status: 'PENDENTE', // Rule 3: NEVER classify unexpired signal as win/loss
    payoutPercent: params.payoutPercent ?? DEFAULT_PAYOUT_PERCENT,
    tieRule: params.tieRule ?? DEFAULT_TIE_RULE,
    netReturnUnits: null,
    settledAtBrt: null,
    imageRefHash: params.imageRefHash || null,
    confidencePct: analysis.technicalConfidence ?? null,
    buyConfidencePct: analysis.buyConfidencePct ?? null,
    sellConfidencePct: analysis.sellConfidencePct ?? null,
    confidenceBucket: getConfidenceBucket(analysis.technicalConfidence),
    marketRegime: analysis.marketRegime || 'INDETERMINADO',
  };

  ledger.unshift(record);
  await persistLedger(filePath, ledger);
  return record;
}

export async function invalidatePendingSignal(params: {
  asset?: string | null;
  entryTimeBrt?: string | null;
  reason?: string;
  tenant?: TenantRef;
}): Promise<boolean> {
  if (!params.asset) return false;
  const { ledger, filePath } = await ensureLedgerLoaded(params.tenant);
  const target = ledger.find(
    (s) =>
      s.status === 'PENDENTE' &&
      s.asset === params.asset &&
      (!params.entryTimeBrt || s.entryTimeBrt.endsWith(params.entryTimeBrt.replace(/\s*BRT$/i, '').trim())),
  );
  if (!target) return false;
  target.status = 'SEM_DADOS';
  target.note = params.reason || 'Sinal cancelado/invalidado antes ou no momento da entrada; excluído da taxa de acerto.';
  await persistLedger(filePath, ledger);
  return true;
}

export async function settlePendingSignals(
  payoutPercent = DEFAULT_PAYOUT_PERCENT,
  tieRule: TieRule = DEFAULT_TIE_RULE,
  tenant?: TenantRef,
): Promise<{ settledNow: number; stillPending: number }> {
  const { ledger, filePath } = await ensureLedgerLoaded(tenant);
  const nowMs = Date.now();
  let settledNow = 0;
  let stillPending = 0;

  const maxExternalPerPass = 8;
  const budgetDeadlineMs = nowMs + 6500;
  let externalLookupsDone = 0;

  for (const sig of ledger) {
    // Re-evaluate existing non-pending payout math when user switches broker payout/tie rule?
    // Keep original settled prices intact, only recompute netReturnUnits if already has expiryPrice!
    if (sig.status !== 'PENDENTE' && sig.expiryPrice !== null && sig.entryPrice !== null) {
      const outcome = settleBinaryOutcome({
        direction: sig.direction,
        entryPrice: sig.entryPrice,
        expiryPrice: sig.expiryPrice,
        payoutPercent,
        tieRule,
      });
      sig.status = outcome.status;
      sig.payoutPercent = payoutPercent;
      sig.tieRule = tieRule;
      sig.netReturnUnits = outcome.netReturnUnits;
      continue;
    }

    if (sig.status !== 'PENDENTE') continue;

    // Rule 3: Strictly refuse to classify before expiryTimeMs
    if (nowMs < sig.expiryTimeMs) {
      stillPending += 1;
      continue;
    }

    if (externalLookupsDone >= maxExternalPerPass || Date.now() >= budgetDeadlineMs) {
      stillPending += 1;
      continue;
    }
    externalLookupsDone += 1;

    const symbolQuery = sig.normalizedSymbol || sig.asset;
    if (sig.entryPrice === null) {
      const entryRef = await fetchReferencePriceAtTime(symbolQuery, sig.entryTimeMs, sig.timeframe);
      if (entryRef) {
        sig.entryPrice = entryRef.price;
        sig.entryPriceSource = entryRef.source;
      }
    }

    const expiryRef = await fetchReferencePriceAtTime(symbolQuery, sig.expiryTimeMs, sig.timeframe);
    if (!expiryRef || sig.entryPrice === null) {
      sig.status = 'SEM_DADOS';
      sig.note = 'Preço histórico real indisponível no horário exato de vencimento; não foi simulado resultado.';
      settledNow += 1;
      continue;
    }

    const outcome = settleBinaryOutcome({
      direction: sig.direction,
      entryPrice: sig.entryPrice,
      expiryPrice: expiryRef.price,
      payoutPercent,
      tieRule,
    });

    const settledBrt = formatTimestampBrt(nowMs);
    sig.expiryPrice = expiryRef.price;
    sig.expiryPriceSource = expiryRef.source;
    sig.status = outcome.status;
    sig.payoutPercent = payoutPercent;
    sig.tieRule = tieRule;
    sig.netReturnUnits = outcome.netReturnUnits;
    sig.settledAtBrt = `${settledBrt.dateBrt} ${settledBrt.timeBrt}`;
    settledNow += 1;
  }

  await persistLedger(filePath, ledger);
  return { settledNow, stillPending };
}

function aggregateByDimension(
  records: SignalRecord[],
  keyFn: (r: SignalRecord) => string,
): DimensionStats[] {
  const map = new Map<string, SignalRecord[]>();
  for (const r of records) {
    const k = keyFn(r);
    const arr = map.get(k);
    if (arr) arr.push(r);
    else map.set(k, [r]);
  }

  const out: DimensionStats[] = [];
  for (const [key, group] of map.entries()) {
    let pending = 0;
    let wins = 0;
    let losses = 0;
    let ties = 0;
    let netUnits = 0;

    for (const r of group) {
      if (r.status === 'PENDENTE') pending += 1;
      else if (r.status === 'GANHO') wins += 1;
      else if (r.status === 'PERDA') losses += 1;
      else if (r.status === 'EMPATE') ties += 1;
      if (typeof r.netReturnUnits === 'number') {
        netUnits += r.netReturnUnits;
      }
    }

    const decided = wins + losses;
    out.push({
      key,
      total: group.length,
      pending,
      decided,
      wins,
      losses,
      ties,
      // Rule 10: Suppress win rate when sub-sample is below MIN_SAMPLE_FOR_STATS
      winRatePct: decided >= MIN_SAMPLE_FOR_STATS ? Number(((wins / decided) * 100).toFixed(2)) : null,
      netUnits: Number(netUnits.toFixed(2)),
    });
  }

  return out.sort((a, b) => b.total - a.total);
}

export async function getValidationSummary(
  payoutPercent = DEFAULT_PAYOUT_PERCENT,
  tieRule: TieRule = DEFAULT_TIE_RULE,
  settleExpired = true,
  tenant?: TenantRef,
): Promise<SignalValidationSummary> {
  if (settleExpired) {
    await settlePendingSignals(payoutPercent, tieRule, tenant);
  }
  const { ledger } = await ensureLedgerLoaded(tenant);

  let pendingSignals = 0;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let unverified = 0;
  let netUnits = 0;

  for (const r of ledger) {
    if (r.status === 'PENDENTE') pendingSignals += 1;
    else if (r.status === 'GANHO') wins += 1;
    else if (r.status === 'PERDA') losses += 1;
    else if (r.status === 'EMPATE') ties += 1;
    else if (r.status === 'SEM_DADOS') unverified += 1;

    if (typeof r.netReturnUnits === 'number') {
      netUnits += r.netReturnUnits;
    }
  }

  const settledSignals = wins + losses + ties;
  const decidedSignals = wins + losses;
  const sampleSufficient = decidedSignals >= MIN_SAMPLE_FOR_STATS;
  const breakEvenWinRatePct = computeBreakEvenWinRatePct(payoutPercent);
  const wilson = computeWilson95Pct(wins, decidedSignals);

  const winRatePct = sampleSufficient
    ? Number(((wins / decidedSignals) * 100).toFixed(2))
    : null;
  const lossRatePct = sampleSufficient
    ? Number(((losses / decidedSignals) * 100).toFixed(2))
    : null;

  const expectedValuePerTrade =
    sampleSufficient && settledSignals > 0
      ? Number((netUnits / settledSignals).toFixed(4))
      : null;

  const insufficientSampleMessage = sampleSufficient
    ? null
    : `Amostra insuficiente (${decidedSignals}/${MIN_SAMPLE_FOR_STATS} operações decididas). Por rigor estatístico, a porcentagem de precisão fica bloqueada e nenhuma alteração na estratégia é permitida até atingir o mínimo de ${MIN_SAMPLE_FOR_STATS} liquidações verificadas.`;

  return {
    minSampleRequired: MIN_SAMPLE_FOR_STATS,
    payoutPercent,
    tieRule,
    breakEvenWinRatePct,
    totalSignals: ledger.length,
    pendingSignals,
    settledSignals,
    decidedSignals,
    wins,
    losses,
    ties,
    unverified,
    sampleSufficient,
    winRatePct,
    lossRatePct,
    wilson95LowPct: wilson?.low ?? null,
    wilson95HighPct: wilson?.high ?? null,
    netUnits: Number(netUnits.toFixed(2)),
    expectedValuePerTrade,
    autoStrategyMutationAllowed: false,
    demoValidated: ledger.some((s) => s.origin === 'DEMO_ACCOUNT' && s.status !== 'PENDENTE'),
    insufficientSampleMessage,
    byAsset: aggregateByDimension(ledger, (r) => r.asset),
    byTimeframe: aggregateByDimension(ledger, (r) => r.timeframe),
    byDirection: aggregateByDimension(ledger, (r) => r.direction),
    byExpiration: aggregateByDimension(ledger, (r) => r.expirationLabel),
    byConfidenceBand: aggregateByDimension(
      ledger,
      (r) => r.confidenceBucket || getConfidenceBucket(r.confidencePct),
    ),
    byHourBrt: aggregateByDimension(ledger, (r) => {
      const hh = r.entryTimeBrt?.split(' ')[1]?.slice(0, 2);
      return hh ? `${hh}h BRT` : 'Indefinido';
    }),
    byMarketRegime: aggregateByDimension(ledger, (r) => r.marketRegime || 'INDETERMINADO'),
    signals: ledger.slice(0, 100),
  };
}

// ============================================================================
// STRICTLY CAUSAL WALK-FORWARD HISTORICAL BACKTESTER (ZERO LOOK-AHEAD LEAKAGE)
// ============================================================================
function calcEma(values: number[], period: number): number {
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

/**
 * Strictly receives ONLY candles[0..t] (causal slice). Impossible to access future bars.
 */
function evaluateCausalSignalAtBar(causalHistory: CandlePoint[]): 'COMPRA' | 'VENDA' | 'AGUARDAR' {
  if (causalHistory.length < 25) return 'AGUARDAR';

  const closes = causalHistory.map((c) => c.close);
  const ema9 = calcEma(closes.slice(-25), 9);
  const ema9Prev = calcEma(closes.slice(-26, -1), 9);
  const ema21 = calcEma(closes.slice(-30), 21);
  const rsi14 = calcRsi(closes, 14);

  const cur = causalHistory[causalHistory.length - 1];
  const prev = causalHistory[causalHistory.length - 2];

  const recentRanges = causalHistory.slice(-14).map((c) => Math.max(1e-9, c.high - c.low));
  const atr = recentRanges.reduce((a, b) => a + b, 0) / recentRanges.length;

  const curRange = Math.max(1e-9, cur.high - cur.low);
  const curBody = Math.abs(cur.close - cur.open);
  const bodyRatio = curBody / curRange;

  // Reject low-conviction / doji / sideways chop
  if (bodyRatio < 0.45 || curRange < atr * 0.5) return 'AGUARDAR';

  // Reject overextended climax bars (avoid buying/selling exhaustion)
  if (Math.abs(cur.close - ema9) > atr * 1.8) return 'AGUARDAR';

  const uptrend = ema9 > ema21 && ema9 > ema9Prev;
  const downtrend = ema9 < ema21 && ema9 < ema9Prev;

  // Bullish confirmation after pullback/hold near EMA9/21, not overbought
  if (
    uptrend &&
    cur.close > cur.open &&
    cur.close > prev.high &&
    cur.low <= ema9 * 1.003 &&
    rsi14 >= 45 &&
    rsi14 <= 68
  ) {
    return 'COMPRA';
  }

  // Bearish confirmation after pullback/hold near EMA9/21, not oversold
  if (
    downtrend &&
    cur.close < cur.open &&
    cur.close < prev.low &&
    cur.high >= ema9 * 0.997 &&
    rsi14 >= 32 &&
    rsi14 <= 55
  ) {
    return 'VENDA';
  }

  return 'AGUARDAR';
}

export async function runCausalWalkForwardBacktest(params: {
  symbol: string;
  timeframe?: string;
  expirationBars?: number;
  payoutPercent?: number;
  tieRule?: TieRule;
}): Promise<WalkForwardBacktestResult> {
  const timeframe = params.timeframe || '15m';
  const expirationBars = Math.max(1, Math.min(8, params.expirationBars ?? 1));
  const payoutPercent = params.payoutPercent ?? DEFAULT_PAYOUT_PERCENT;
  const tieRule = params.tieRule ?? DEFAULT_TIE_RULE;

  const rangeForInterval =
    timeframe === '1m' ? '5d' : timeframe === '5m' ? '1mo' : timeframe === '15m' ? '1mo' : '3mo';
  const hist = await fetchHistoricalCandles(params.symbol, timeframe, rangeForInterval);

  if (!hist || hist.candles.length < 40) {
    throw new Error(`Dados históricos insuficientes no Yahoo Finance para ${params.symbol} (${timeframe}).`);
  }

  const candles = hist.candles;
  const warmupBars = 30;
  const simulatedRecords: SignalRecord[] = [];
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let netUnits = 0;

  let t = warmupBars;
  while (t < candles.length - expirationBars) {
    // STRICT NO-LOOKAHEAD SLICE: evaluator sees strictly bars [0..t]
    const causalSlice = candles.slice(0, t + 1);
    const decision = evaluateCausalSignalAtBar(causalSlice);

    if (decision === 'COMPRA' || decision === 'VENDA') {
      const entryBar = candles[t];
      const expiryBar = candles[t + expirationBars];
      const outcome = settleBinaryOutcome({
        direction: decision,
        entryPrice: entryBar.close,
        expiryPrice: expiryBar.close,
        payoutPercent,
        tieRule,
      });

      if (outcome.status === 'GANHO') wins += 1;
      else if (outcome.status === 'PERDA') losses += 1;
      else ties += 1;

      netUnits += outcome.netReturnUnits;
      simulatedRecords.push({
        id: `wf_${t}`,
        origin: 'DEMO_ACCOUNT',
        asset: hist.displayName,
        normalizedSymbol: hist.symbol,
        direction: decision,
        timeframe: hist.timeframe,
        expirationLabel: `${expirationBars} candle(s)`,
        expirationMinutes: parseExpirationMinutes(undefined, hist.timeframe) * expirationBars,
        issuedAtMs: entryBar.timestampMs,
        issuedAtBrt: entryBar.timeBrt,
        entryTimeMs: entryBar.timestampMs,
        entryTimeBrt: entryBar.timeBrt,
        expiryTimeMs: expiryBar.timestampMs,
        expiryTimeBrt: expiryBar.timeBrt,
        entryPrice: entryBar.close,
        entryPriceSource: hist.provider,
        expiryPrice: expiryBar.close,
        expiryPriceSource: hist.provider,
        status: outcome.status,
        payoutPercent,
        tieRule,
        netReturnUnits: outcome.netReturnUnits,
        settledAtBrt: expiryBar.timeBrt,
      });

      // Step forward past expiration to avoid overlapping correlated trades
      t += expirationBars;
    } else {
      t += 1;
    }
  }

  const decidedSignals = wins + losses;
  const sampleSufficient = decidedSignals >= MIN_SAMPLE_FOR_STATS;
  const wilson = computeWilson95Pct(wins, decidedSignals);
  const startBrt = formatTimestampBrt(candles[warmupBars].timestampMs);
  const endBrt = formatTimestampBrt(candles[candles.length - 1].timestampMs);

  return {
    symbol: hist.symbol,
    displayName: hist.displayName,
    provider: hist.provider,
    timeframe: hist.timeframe,
    expirationBars,
    expirationLabel: `${expirationBars} candle(s) (${hist.timeframe})`,
    payoutPercent,
    tieRule,
    breakEvenWinRatePct: computeBreakEvenWinRatePct(payoutPercent),
    totalBarsEvaluated: candles.length - warmupBars - expirationBars,
    causalWindowBars: warmupBars,
    noLookaheadVerified: true,
    totalSignals: simulatedRecords.length,
    decidedSignals,
    wins,
    losses,
    ties,
    sampleSufficient,
    winRatePct: sampleSufficient ? Number(((wins / decidedSignals) * 100).toFixed(2)) : null,
    wilson95LowPct: wilson?.low ?? null,
    wilson95HighPct: wilson?.high ?? null,
    netUnits: Number(netUnits.toFixed(2)),
    insufficientSampleMessage: sampleSufficient
      ? null
      : `Amostra histórica insuficiente (${decidedSignals}/${MIN_SAMPLE_FOR_STATS} entradas decididas). Taxa de acerto omitida.`,
    byDirection: aggregateByDimension(simulatedRecords, (r) => r.direction),
    periodStartBrt: `${startBrt.dateBrt} ${startBrt.shortTimeBrt}`,
    periodEndBrt: `${endBrt.dateBrt} ${endBrt.shortTimeBrt}`,
    disclaimer:
      'Backtest walk-forward estritamente causal sobre candles históricos reais (Yahoo Finance), avaliando regra técnica determinística sem uso da API Gemini e sem dinheiro real. Resultados históricos não garantem retornos futuros e não substituem validação em conta demo.',
  };
}
