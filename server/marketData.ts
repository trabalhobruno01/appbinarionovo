import type { CandlePoint, MarketCategory, MarketQuote } from '../shared/types.ts';
import { formatTimestampBrt, getSynchronizedBrasiliaTime } from './timeService.ts';
import { recordQuoteLookup } from './usageTracker.ts';

const QUOTE_CACHE_TTL_MS = 15_000;
const quoteCache = new Map<string, { expiresAt: number; quote: MarketQuote }>();
const inFlightQuotes = new Map<string, Promise<MarketQuote>>();
let binanceBlockedUntilMs = 0;

interface NormalizedSymbol {
  binanceSymbol?: string;
  yahooSymbol: string;
  twelveDataSymbol?: string;
  displayName: string;
  market: MarketCategory;
  currency: string;
  note?: string;
}

const KNOWN_CRYPTO_BASES = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT',
  'MATIC', 'POL', 'LTC', 'BCH', 'UNI', 'ATOM', 'NEAR', 'APT', 'ARB', 'OP',
  'SUI', 'TON', 'TRX', 'SHIB', 'PEPE', 'WIF', 'AAVE', 'INJ', 'FET', 'RENDER',
]);

const B3_COMMON_TICKERS = new Set([
  'PETR4', 'PETR3', 'VALE3', 'ITUB4', 'BBDC4', 'BBAS3', 'ABEV3', 'WEGE3',
  'B3SA3', 'RENT3', 'MGLU3', 'PRIO3', 'SUZB3', 'GGBR4', 'ELET3', 'ELET6',
  'ITSA4', 'VIVT3', 'RADL3', 'JBSS3', 'RAIL3', 'SBSP3', 'LREN3', 'EQTL3',
  'BBSE3', 'CSAN3', 'EMBR3', 'HAPV3', 'TOTS3', 'UGPA3',
]);

export function normalizeAssetQuery(raw: string): NormalizedSymbol | null {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/-/g, '/');

  if (!cleaned) return null;

  // Common index aliases
  if (['IBOV', 'IBOVESPA', '^BVSP', 'BOVESPA'].includes(cleaned)) {
    return {
      yahooSymbol: '^BVSP',
      displayName: 'Ibovespa (^BVSP)',
      market: 'INDEX',
      currency: 'PTS',
    };
  }
  if (/^(WIN|WINFUT|IND|INDFUT)/.test(cleaned)) {
    return {
      yahooSymbol: '^BVSP',
      displayName: 'Ibovespa À Vista (Ref. Índice WIN)',
      market: 'INDEX',
      currency: 'PTS',
      note: 'Referência à vista do Índice Ibovespa (^BVSP); contrato futuro WIN possui ajuste de taxa/base.',
    };
  }
  if (/^(WDO|WDOFUT|DOL|DOLFUT)/.test(cleaned) || ['USD/BRL', 'USDBRL', 'DOLAR', 'BRL=X'].includes(cleaned)) {
    return {
      yahooSymbol: 'BRL=X',
      twelveDataSymbol: 'USD/BRL',
      displayName: 'USD/BRL (Dólar Comercial)',
      market: 'FOREX',
      currency: 'BRL',
      note: cleaned.startsWith('WD') || cleaned.startsWith('DO') ? 'Referência spot USD/BRL (futuro WDO tem cupom cambial).' : undefined,
    };
  }
  if (['SP500', 'S&P500', 'SPX', '^GSPC', 'US500'].includes(cleaned)) {
    return {
      yahooSymbol: '^GSPC',
      displayName: 'S&P 500 (^GSPC)',
      market: 'INDEX',
      currency: 'USD',
    };
  }
  if (['NASDAQ', 'NDX', '^IXIC', 'NAS100', 'US100'].includes(cleaned)) {
    return {
      yahooSymbol: '^IXIC',
      displayName: 'Nasdaq Composite (^IXIC)',
      market: 'INDEX',
      currency: 'USD',
    };
  }
  if (['DOW', 'DJI', 'DJIA', '^DJI', 'US30'].includes(cleaned)) {
    return {
      yahooSymbol: '^DJI',
      displayName: 'Dow Jones (^DJI)',
      market: 'INDEX',
      currency: 'USD',
    };
  }
  if (['XAU/USD', 'XAUUSD', 'GOLD', 'OURO', 'GC=F'].includes(cleaned)) {
    return {
      yahooSymbol: 'GC=F',
      twelveDataSymbol: 'XAU/USD',
      displayName: 'Ouro Futuro (GC=F)',
      market: 'COMMODITY',
      currency: 'USD',
    };
  }
  if (['WTI', 'USOIL', 'OIL', 'PETROLEO', 'CL=F'].includes(cleaned)) {
    return {
      yahooSymbol: 'CL=F',
      displayName: 'Petróleo WTI (CL=F)',
      market: 'COMMODITY',
      currency: 'USD',
    };
  }

  // Crypto pairs like BTCUSDT, BTC/USDT, BTC/USD, BITCOIN
  const cryptoMap: Record<string, string> = {
    BITCOIN: 'BTC',
    ETHEREUM: 'ETH',
    SOLANA: 'SOL',
    RIPPLE: 'XRP',
    CARDANO: 'ADA',
    DOGECOIN: 'DOGE',
  };
  const baseFromName = cryptoMap[cleaned];
  if (baseFromName) {
    return {
      binanceSymbol: `${baseFromName}USDT`,
      yahooSymbol: `${baseFromName}-USD`,
      twelveDataSymbol: `${baseFromName}/USD`,
      displayName: `${baseFromName}/USDT`,
      market: 'CRYPTO',
      currency: 'USDT',
    };
  }

  const slashParts = cleaned.split('/');
  if (slashParts.length === 2) {
    const [base, quote] = slashParts;
    if (KNOWN_CRYPTO_BASES.has(base)) {
      const binanceQuote = quote === 'USD' ? 'USDT' : quote;
      return {
        binanceSymbol: `${base}${binanceQuote}`,
        yahooSymbol: `${base}-${quote === 'USDT' ? 'USD' : quote}`,
        twelveDataSymbol: `${base}/${quote}`,
        displayName: `${base}/${quote}`,
        market: 'CRYPTO',
        currency: quote,
      };
    }
    // Standard Forex pair e.g. EUR/USD, GBP/USD, EUR/BRL
    if (base.length === 3 && quote.length === 3) {
      return {
        yahooSymbol: base === 'USD' ? `${quote}=X` : `${base}${quote}=X`,
        twelveDataSymbol: `${base}/${quote}`,
        displayName: `${base}/${quote}`,
        market: 'FOREX',
        currency: quote,
      };
    }
  }

  // Concatenated crypto e.g. BTCUSDT, ETHBRL
  for (const quote of ['USDT', 'BRL', 'USDC', 'USD']) {
    if (cleaned.endsWith(quote) && cleaned.length > quote.length) {
      const base = cleaned.slice(0, -quote.length);
      if (KNOWN_CRYPTO_BASES.has(base)) {
        const binanceQuote = quote === 'USD' ? 'USDT' : quote;
        return {
          binanceSymbol: `${base}${binanceQuote}`,
          yahooSymbol: `${base}-${quote === 'USDT' ? 'USD' : quote}`,
          twelveDataSymbol: `${base}/${quote}`,
          displayName: `${base}/${quote}`,
          market: 'CRYPTO',
          currency: quote,
        };
      }
    }
  }

  if (KNOWN_CRYPTO_BASES.has(cleaned)) {
    return {
      binanceSymbol: `${cleaned}USDT`,
      yahooSymbol: `${cleaned}-USD`,
      twelveDataSymbol: `${cleaned}/USD`,
      displayName: `${cleaned}/USDT`,
      market: 'CRYPTO',
      currency: 'USDT',
    };
  }

  // Concatenated Forex 6 chars (EURUSD, GBPJPY, AUDUSD)
  if (/^[A-Z]{6}$/.test(cleaned)) {
    const base = cleaned.slice(0, 3);
    const quote = cleaned.slice(3, 6);
    const fxCurrencies = new Set(['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'BRL']);
    if (fxCurrencies.has(base) && fxCurrencies.has(quote)) {
      return {
        yahooSymbol: base === 'USD' ? `${quote}=X` : `${base}${quote}=X`,
        twelveDataSymbol: `${base}/${quote}`,
        displayName: `${base}/${quote}`,
        market: 'FOREX',
        currency: quote,
      };
    }
  }

  // Brazilian B3 ticker (e.g. PETR4, PETR4.SA, BOVA11)
  if (cleaned.endsWith('.SA')) {
    return {
      yahooSymbol: cleaned,
      displayName: cleaned.replace('.SA', ' (B3)'),
      market: 'B3',
      currency: 'BRL',
    };
  }
  if (B3_COMMON_TICKERS.has(cleaned) || /^[A-Z]{4}(3|4|5|6|11)$/.test(cleaned)) {
    return {
      yahooSymbol: `${cleaned}.SA`,
      displayName: `${cleaned} (B3)`,
      market: 'B3',
      currency: 'BRL',
    };
  }

  // US Equity / ETF fallback (1-5 uppercase letters)
  if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(cleaned)) {
    return {
      yahooSymbol: cleaned,
      twelveDataSymbol: cleaned,
      displayName: cleaned,
      market: 'US_EQUITY',
      currency: 'USD',
    };
  }

  // Pass-through Yahoo style symbol
  if (/^[\^A-Z0-9.=/-]{2,14}$/.test(cleaned)) {
    return {
      yahooSymbol: cleaned,
      displayName: cleaned,
      market: 'UNKNOWN',
      currency: 'USD',
    };
  }

  return null;
}

function mapTimeframeToBinance(tf?: string | null): string {
  const normalized = (tf || '15m').toLowerCase().trim();
  const map: Record<string, string> = {
    '1m': '1m', 'm1': '1m',
    '3m': '3m', 'm3': '3m',
    '5m': '5m', 'm5': '5m',
    '15m': '15m', 'm15': '15m',
    '30m': '30m', 'm30': '30m',
    '1h': '1h', 'h1': '1h', '60m': '1h',
    '2h': '2h', 'h2': '2h',
    '4h': '4h', 'h4': '4h',
    '1d': '1d', 'd1': '1d', 'diario': '1d', 'diário': '1d',
    '1w': '1w', 'w1': '1w', 'semanal': '1w',
  };
  return map[normalized] || '15m';
}

function mapTimeframeToYahoo(tf?: string | null): { interval: string; range: string; label: string } {
  const normalized = (tf || '15m').toLowerCase().trim();
  if (['1m', 'm1'].includes(normalized)) return { interval: '1m', range: '1d', label: '1m' };
  if (['2m', 'm2'].includes(normalized)) return { interval: '2m', range: '1d', label: '2m' };
  if (['5m', 'm5'].includes(normalized)) return { interval: '5m', range: '5d', label: '5m' };
  if (['15m', 'm15'].includes(normalized)) return { interval: '15m', range: '5d', label: '15m' };
  if (['30m', 'm30'].includes(normalized)) return { interval: '30m', range: '5d', label: '30m' };
  if (['1h', 'h1', '60m', '4h', 'h4'].includes(normalized)) return { interval: '60m', range: '1mo', label: normalized.includes('4') ? '4h (via 1h)' : '1h' };
  if (['1d', 'd1', 'diario', 'diário'].includes(normalized)) return { interval: '1d', range: '6mo', label: '1D' };
  if (['1w', 'w1', 'semanal'].includes(normalized)) return { interval: '1wk', range: '2y', label: '1S' };
  return { interval: '15m', range: '5d', label: '15m' };
}

async function fetchJsonTimeout(url: string, timeoutMs = 3000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ChartPulseAI/1.0)',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromBinance(norm: NormalizedSymbol, timeframe: string): Promise<MarketQuote | null> {
  if (!norm.binanceSymbol || Date.now() < binanceBlockedUntilMs) return null;
  const interval = mapTimeframeToBinance(timeframe);
  const tickerUrl = `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(norm.binanceSymbol)}`;
  const klinesUrl = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(norm.binanceSymbol)}&interval=${interval}&limit=24`;

  const [tickerRes, klinesRes] = await Promise.all([
    fetchJsonTimeout(tickerUrl),
    fetchJsonTimeout(klinesUrl),
  ]);

  if (tickerRes.status === 451 || tickerRes.status === 403) {
    // Skip Binance for 10 minutes in geo-restricted server regions
    binanceBlockedUntilMs = Date.now() + 600_000;
    return null;
  }
  if (!tickerRes.ok) return null;
  const ticker = (await tickerRes.json()) as {
    lastPrice?: string;
    priceChangePercent?: string;
    highPrice?: string;
    lowPrice?: string;
    volume?: string;
  };
  const price = Number(ticker.lastPrice);
  if (!Number.isFinite(price)) return null;

  let candles: CandlePoint[] = [];
  if (klinesRes.ok) {
    const rawKlines = (await klinesRes.json()) as Array<[number, string, string, string, string, string]>;
    candles = rawKlines.map((k) => {
      const ts = k[0];
      return {
        timestampMs: ts,
        timeBrt: formatTimestampBrt(ts).shortTimeBrt,
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      };
    });
  }

  const timeSync = await getSynchronizedBrasiliaTime();
  return {
    symbol: norm.binanceSymbol,
    displayName: norm.displayName,
    market: norm.market,
    provider: 'Binance Spot API',
    price,
    currency: norm.currency,
    changePercent24h: Number.isFinite(Number(ticker.priceChangePercent))
      ? Number(ticker.priceChangePercent)
      : null,
    high: Number.isFinite(Number(ticker.highPrice)) ? Number(ticker.highPrice) : null,
    low: Number.isFinite(Number(ticker.lowPrice)) ? Number(ticker.lowPrice) : null,
    volume: Number.isFinite(Number(ticker.volume)) ? Number(ticker.volume) : null,
    candles,
    timeframe: interval,
    fetchedAtBrt: `${timeSync.dateBrt} ${timeSync.timeBrt}`,
    fetchedAtIso: timeSync.isoBrt,
    available: true,
    warning: norm.note,
  };
}

async function fetchFromYahoo(norm: NormalizedSymbol, timeframe?: string | null): Promise<MarketQuote | null> {
  const { interval, range, label } = mapTimeframeToYahoo(timeframe);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(norm.yahooSymbol)}?interval=${interval}&range=${range}`;
  const res = await fetchJsonTimeout(url);
  if (!res.ok) return null;

  const payload = (await res.json()) as {
    chart?: {
      result?: Array<{
        meta?: {
          regularMarketPrice?: number;
          chartPreviousClose?: number;
          previousClose?: number;
          regularMarketDayHigh?: number;
          regularMarketDayLow?: number;
          regularMarketVolume?: number;
          currency?: string;
          regularMarketTime?: number;
        };
        timestamp?: number[];
        indicators?: {
          quote?: Array<{
            open?: Array<number | null>;
            high?: Array<number | null>;
            low?: Array<number | null>;
            close?: Array<number | null>;
            volume?: Array<number | null>;
          }>;
        };
      }>;
    };
  };

  const result = payload.chart?.result?.[0];
  const meta = result?.meta;
  const price = meta?.regularMarketPrice;
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;

  const prev = meta?.chartPreviousClose ?? meta?.previousClose;
  const changePct =
    typeof prev === 'number' && prev > 0 ? ((price - prev) / prev) * 100 : null;

  const timestamps = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0];
  const candles: CandlePoint[] = [];

  if (q) {
    const startIdx = Math.max(0, timestamps.length - 24);
    for (let i = startIdx; i < timestamps.length; i++) {
      const o = q.open?.[i];
      const h = q.high?.[i];
      const l = q.low?.[i];
      const c = q.close?.[i];
      const v = q.volume?.[i] ?? 0;
      if (o != null && h != null && l != null && c != null) {
        const tsMs = timestamps[i] * 1000;
        candles.push({
          timestampMs: tsMs,
          timeBrt: formatTimestampBrt(tsMs).shortTimeBrt,
          open: o,
          high: h,
          low: l,
          close: c,
          volume: v ?? 0,
        });
      }
    }
  }

  const timeSync = await getSynchronizedBrasiliaTime();
  return {
    symbol: norm.yahooSymbol,
    displayName: norm.displayName,
    market: norm.market,
    provider: 'Yahoo Finance',
    price,
    currency: meta?.currency || norm.currency,
    changePercent24h: changePct !== null ? Number(changePct.toFixed(2)) : null,
    high: typeof meta?.regularMarketDayHigh === 'number' ? meta.regularMarketDayHigh : null,
    low: typeof meta?.regularMarketDayLow === 'number' ? meta.regularMarketDayLow : null,
    volume: typeof meta?.regularMarketVolume === 'number' ? meta.regularMarketVolume : null,
    candles,
    timeframe: label,
    fetchedAtBrt: `${timeSync.dateBrt} ${timeSync.timeBrt}`,
    fetchedAtIso: timeSync.isoBrt,
    available: true,
    warning: norm.note,
  };
}

async function fetchFromTwelveData(norm: NormalizedSymbol, timeframe?: string | null): Promise<MarketQuote | null> {
  const apiKey = process.env.TWELVE_DATA_API_KEY?.trim();
  if (!apiKey || !norm.twelveDataSymbol) return null;

  const intervalMap: Record<string, string> = {
    '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '4h': '4h', '1d': '1day',
  };
  const tf = intervalMap[(timeframe || '15m').toLowerCase()] || '15min';
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(norm.twelveDataSymbol)}&interval=${tf}&outputsize=20&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetchJsonTimeout(url);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    status?: string;
    values?: Array<{ datetime: string; open: string; high: string; low: string; close: string; volume?: string }>;
  };
  if (data.status === 'error' || !Array.isArray(data.values) || data.values.length === 0) return null;

  const latest = data.values[0];
  const price = Number(latest.close);
  if (!Number.isFinite(price)) return null;

  const candles: CandlePoint[] = [...data.values].reverse().map((v) => {
    const ms = new Date(v.datetime.replace(' ', 'T') + 'Z').getTime();
    return {
      timestampMs: Number.isNaN(ms) ? Date.now() : ms,
      timeBrt: Number.isNaN(ms) ? v.datetime.slice(11, 16) : formatTimestampBrt(ms).shortTimeBrt,
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: Number(v.volume || 0),
    };
  });

  const timeSync = await getSynchronizedBrasiliaTime();
  return {
    symbol: norm.twelveDataSymbol,
    displayName: norm.displayName,
    market: norm.market,
    provider: 'Twelve Data',
    price,
    currency: norm.currency,
    changePercent24h: null,
    high: Number(latest.high),
    low: Number(latest.low),
    volume: latest.volume ? Number(latest.volume) : null,
    candles,
    timeframe: tf,
    fetchedAtBrt: `${timeSync.dateBrt} ${timeSync.timeBrt}`,
    fetchedAtIso: timeSync.isoBrt,
    available: true,
    warning: norm.note,
  };
}

async function fetchMarketQuoteUncached(rawAsset: string, timeframe?: string | null): Promise<MarketQuote> {
  const timeSync = await getSynchronizedBrasiliaTime();
  const norm = normalizeAssetQuery(rawAsset);
  if (!norm) {
    return {
      symbol: rawAsset,
      displayName: rawAsset,
      market: 'UNKNOWN',
      provider: 'Nenhum',
      price: 0,
      currency: '',
      changePercent24h: null,
      high: null,
      low: null,
      volume: null,
      candles: [],
      timeframe: timeframe || '-',
      fetchedAtBrt: `${timeSync.dateBrt} ${timeSync.timeBrt}`,
      fetchedAtIso: timeSync.isoBrt,
      available: false,
      warning: `Símbolo "${rawAsset}" não mapeado para provedores suportados.`,
    };
  }

  // Try providers in order of reliability per asset class
  if (norm.binanceSymbol) {
    try {
      const binanceQuote = await fetchFromBinance(norm, timeframe || '15m');
      if (binanceQuote) return binanceQuote;
    } catch {
      // Fallback to Twelve Data / Yahoo
    }
  }

  try {
    const tdQuote = await fetchFromTwelveData(norm, timeframe);
    if (tdQuote) return tdQuote;
  } catch {
    // Fallback to Yahoo
  }

  try {
    const yahooQuote = await fetchFromYahoo(norm, timeframe);
    if (yahooQuote) return yahooQuote;
  } catch {
    // Exhausted providers
  }

  return {
    symbol: norm.yahooSymbol,
    displayName: norm.displayName,
    market: norm.market,
    provider: 'Indisponível',
    price: 0,
    currency: norm.currency,
    changePercent24h: null,
    high: null,
    low: null,
    volume: null,
    candles: [],
    timeframe: timeframe || '-',
    fetchedAtBrt: `${timeSync.dateBrt} ${timeSync.timeBrt}`,
    fetchedAtIso: timeSync.isoBrt,
    available: false,
    warning: `Não foi possível obter cotação em tempo real para ${norm.displayName} neste momento.`,
  };
}

export async function fetchMarketQuote(rawAsset: string | null | undefined, timeframe?: string | null): Promise<MarketQuote> {
  if (!rawAsset || !rawAsset.trim()) {
    const timeSync = await getSynchronizedBrasiliaTime();
    return {
      symbol: '',
      displayName: 'Ativo não identificado',
      market: 'UNKNOWN',
      provider: 'Nenhum',
      price: 0,
      currency: '',
      changePercent24h: null,
      high: null,
      low: null,
      volume: null,
      candles: [],
      timeframe: timeframe || '-',
      fetchedAtBrt: `${timeSync.dateBrt} ${timeSync.timeBrt}`,
      fetchedAtIso: timeSync.isoBrt,
      available: false,
      warning: 'Ativo não identificado na imagem para consulta em tempo real.',
    };
  }

  const cacheKey = `${rawAsset.trim().toUpperCase()}:${(timeframe || '15m').trim().toLowerCase()}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    await recordQuoteLookup(true);
    return cached.quote;
  }

  const pending = inFlightQuotes.get(cacheKey);
  if (pending) {
    return pending;
  }

  const reqPromise = fetchMarketQuoteUncached(rawAsset, timeframe)
    .then(async (quote) => {
      await recordQuoteLookup(false);
      if (quote.available) {
        quoteCache.set(cacheKey, { expiresAt: Date.now() + QUOTE_CACHE_TTL_MS, quote });
        if (quoteCache.size > 60) {
          const oldest = quoteCache.keys().next().value;
          if (oldest) quoteCache.delete(oldest);
        }
      }
      return quote;
    })
    .finally(() => {
      inFlightQuotes.delete(cacheKey);
    });

  inFlightQuotes.set(cacheKey, reqPromise);
  return reqPromise;
}

export async function fetchHistoricalCandles(
  rawAsset: string,
  timeframe = '15m',
  rangeOverride?: string,
): Promise<{
  symbol: string;
  displayName: string;
  provider: string;
  timeframe: string;
  candles: CandlePoint[];
} | null> {
  const norm = normalizeAssetQuery(rawAsset);
  if (!norm) return null;

  const { interval, range, label } = mapTimeframeToYahoo(timeframe);
  const chosenRange = rangeOverride || (interval === '15m' ? '1mo' : interval === '5m' ? '5d' : range);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(norm.yahooSymbol)}?interval=${interval}&range=${chosenRange}`;

  try {
    const res = await fetchJsonTimeout(url, 4500);
    if (!res.ok) return null;
    const payload = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: Array<number | null>;
              high?: Array<number | null>;
              low?: Array<number | null>;
              close?: Array<number | null>;
              volume?: Array<number | null>;
            }>;
          };
        }>;
      };
    };

    const result = payload.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const q = result?.indicators?.quote?.[0];
    if (!q || timestamps.length === 0) return null;

    const candles: CandlePoint[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = q.open?.[i];
      const h = q.high?.[i];
      const l = q.low?.[i];
      const c = q.close?.[i];
      const v = q.volume?.[i] ?? 0;
      if (o != null && h != null && l != null && c != null) {
        const tsMs = timestamps[i] * 1000;
        candles.push({
          timestampMs: tsMs,
          timeBrt: formatTimestampBrt(tsMs).shortTimeBrt,
          open: o,
          high: h,
          low: l,
          close: c,
          volume: v ?? 0,
        });
      }
    }

    if (candles.length === 0) return null;
    return {
      symbol: norm.yahooSymbol,
      displayName: norm.displayName,
      provider: 'Yahoo Finance',
      timeframe: label,
      candles,
    };
  } catch {
    return null;
  }
}

export async function fetchReferencePriceAtTime(
  rawAsset: string,
  targetUnixMs: number,
  timeframe = '5m',
): Promise<{ price: number; source: string; matchedAtBrt: string } | null> {
  // Use recent 5m or 1m candles to locate the real market price closest to targetUnixMs without future bias
  const hist = await fetchHistoricalCandles(rawAsset, timeframe === '1m' ? '1m' : '5m', '5d');
  if (hist && hist.candles.length > 0) {
    let best = hist.candles[0];
    let bestDiff = Math.abs(best.timestampMs - targetUnixMs);
    for (const c of hist.candles) {
      const diff = Math.abs(c.timestampMs - targetUnixMs);
      if (diff < bestDiff) {
        best = c;
        bestDiff = diff;
      }
    }
    // Accept candle match if within 30 minutes of targetUnixMs
    if (bestDiff <= 30 * 60_000) {
      const brt = formatTimestampBrt(best.timestampMs);
      return {
        price: best.close,
        source: `${hist.provider} (${hist.timeframe} @ ${brt.timeBrt})`,
        matchedAtBrt: `${brt.dateBrt} ${brt.timeBrt}`,
      };
    }
  }

  // Fallback to current live quote only if targetUnixMs is within 3 minutes of now
  if (Math.abs(Date.now() - targetUnixMs) <= 3 * 60_000) {
    const q = await fetchMarketQuote(rawAsset, timeframe);
    if (q.available && q.price > 0) {
      return {
        price: q.price,
        source: `${q.provider} (ao vivo)`,
        matchedAtBrt: q.fetchedAtBrt,
      };
    }
  }

  return null;
}
