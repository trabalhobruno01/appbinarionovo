export type DecisionType = 'COMPRA' | 'VENDA' | 'AGUARDAR' | 'SINAL_EXPIRADO';

export type DataFreshnessStatus =
  | 'ATUALIZADO'
  | 'DEFASADO'
  | 'SEM_COTACAO_TEMPO_REAL';

export type MarketCategory =
  | 'CRYPTO'
  | 'B3'
  | 'US_EQUITY'
  | 'FOREX'
  | 'INDEX'
  | 'COMMODITY'
  | 'UNKNOWN';

export interface CandlePoint {
  timestampMs: number;
  timeBrt: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketQuote {
  symbol: string;
  displayName: string;
  market: MarketCategory;
  provider: string;
  price: number;
  currency: string;
  changePercent24h: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  candles: CandlePoint[];
  timeframe: string;
  fetchedAtBrt: string;
  fetchedAtIso: string;
  available: boolean;
  warning?: string;
}

export interface BrasiliaTimeSync {
  unixMs: number;
  isoBrt: string;
  dateBrt: string;
  timeBrt: string;
  shortTimeBrt: string;
  timezone: 'America/Sao_Paulo';
  source: 'timeapi' | 'http-date-sync' | 'system-tz-fallback';
  offsetMs: number;
}

export interface ChartAnalysisResult {
  decision: DecisionType;
  expectedDirection?: 'SUBIDA' | 'QUEDA' | 'INDEFINIDA' | null;
  expired: boolean;
  asset: string | null;
  normalizedSymbol: string | null;
  timeframe: string | null;
  analysisTimeBrt: string;
  photoReceivedAtBrt: string;
  entryWindowBrt: string | null;
  expirationDuration?: string | null;
  exitWindowBrt: string | null;
  timeRemainingToEntry: string | null;
  signalValidity: string | null;
  entryPrice: string | null;
  targetPrice: string | null;
  stopLoss: string | null;
  technicalConfidence: number | null;
  reason: string;
  riskWarning?: string | null;
  entryCondition: string | null;
  cancellationCondition: string | null;
  nextAction: string | null;
  dataFreshnessStatus: DataFreshnessStatus;
  dataFreshnessNote: string;
  needsClarification?: 'ASSET' | 'TIMEFRAME' | 'NEW_PHOTO' | null;
  clarificationQuestion?: string | null;
  analysisQuality?: 'FORTE' | 'MODERADA' | 'INSUFICIENTE' | null;
  waitCategory?:
    | 'IMAGEM_ILEGIVEL'
    | 'MERCADO_LATERAL'
    | 'SINAIS_CONTRADITORIOS'
    | 'AGUARDAR_CONFIRMACAO'
    | null;
  favorableEvidences?: string[];
  contraryEvidences?: string[];
  entryTrigger?: string | null;
  visibleIndicators: string[];
  formattedReport: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  imageDataUrl?: string;
  photoCapturedAtBrt?: string;
  analysis?: ChartAnalysisResult;
  marketQuote?: MarketQuote | null;
  createdAtIso: string;
  createdAtBrt: string;
  error?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  lastAsset?: string | null;
  lastTimeframe?: string | null;
  createdAtIso: string;
  updatedAtIso: string;
  updatedAtBrt: string;
  messages: ChatMessage[];
}

export type SignalStatus = 'PENDENTE' | 'GANHO' | 'PERDA' | 'EMPATE' | 'SEM_DADOS';
export type TieRule = 'REFUND' | 'LOSS';

export interface SignalRecord {
  id: string;
  origin: 'LIVE_AI' | 'DEMO_ACCOUNT';
  asset: string;
  normalizedSymbol: string | null;
  direction: 'COMPRA' | 'VENDA';
  timeframe: string;
  expirationLabel: string;
  expirationMinutes: number;
  issuedAtMs: number;
  issuedAtBrt: string;
  entryTimeMs: number;
  entryTimeBrt: string;
  expiryTimeMs: number;
  expiryTimeBrt: string;
  entryPrice: number | null;
  entryPriceSource: string;
  expiryPrice: number | null;
  expiryPriceSource: string | null;
  status: SignalStatus;
  payoutPercent: number;
  tieRule: TieRule;
  netReturnUnits: number | null;
  settledAtBrt: string | null;
  note?: string;
}

export interface DimensionStats {
  key: string;
  total: number;
  pending: number;
  decided: number;
  wins: number;
  losses: number;
  ties: number;
  winRatePct: number | null;
  netUnits: number;
}

export interface SignalValidationSummary {
  minSampleRequired: number;
  payoutPercent: number;
  tieRule: TieRule;
  breakEvenWinRatePct: number;
  totalSignals: number;
  pendingSignals: number;
  settledSignals: number;
  decidedSignals: number;
  wins: number;
  losses: number;
  ties: number;
  unverified: number;
  sampleSufficient: boolean;
  winRatePct: number | null;
  wilson95LowPct: number | null;
  wilson95HighPct: number | null;
  netUnits: number;
  expectedValuePerTrade: number | null;
  autoStrategyMutationAllowed: false;
  demoValidated: boolean;
  insufficientSampleMessage: string | null;
  byAsset: DimensionStats[];
  byTimeframe: DimensionStats[];
  byDirection: DimensionStats[];
  byExpiration: DimensionStats[];
  signals: SignalRecord[];
}

export interface WalkForwardBacktestResult {
  symbol: string;
  displayName: string;
  provider: string;
  timeframe: string;
  expirationBars: number;
  expirationLabel: string;
  payoutPercent: number;
  tieRule: TieRule;
  breakEvenWinRatePct: number;
  totalBarsEvaluated: number;
  causalWindowBars: number;
  noLookaheadVerified: true;
  totalSignals: number;
  decidedSignals: number;
  wins: number;
  losses: number;
  ties: number;
  sampleSufficient: boolean;
  winRatePct: number | null;
  wilson95LowPct: number | null;
  wilson95HighPct: number | null;
  netUnits: number;
  insufficientSampleMessage: string | null;
  byDirection: DimensionStats[];
  periodStartBrt: string;
  periodEndBrt: string;
  disclaimer: string;
}
