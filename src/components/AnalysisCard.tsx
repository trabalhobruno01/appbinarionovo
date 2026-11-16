import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Clock,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react';
import type { ChartAnalysisResult, MarketQuote } from '../../shared/types.ts';

interface AnalysisCardProps {
  analysis: ChartAnalysisResult;
  marketQuote?: MarketQuote | null;
  onQuickFollowUp?: (question: string) => void;
  showQuickActions?: boolean;
  disabled?: boolean;
}

function formatTimeframeDisplay(tf?: string | null): string {
  const trimmed = (tf || '').trim();
  if (
    !trimmed ||
    /^(m1|1m|1\s*min(uto)?|m1\s*[—–-]\s*1\s*minuto|n[aã]o\s+informado)$/i.test(trimmed)
  ) {
    return 'M1 — 1 minuto';
  }
  return trimmed;
}

export function AnalysisCard({
  analysis,
  marketQuote,
  onQuickFollowUp,
  showQuickActions = false,
  disabled = false,
}: AnalysisCardProps) {
  const isBuy = analysis.decision === 'COMPRA';
  const isSell = analysis.decision === 'VENDA';
  const isExpired = analysis.expired || analysis.decision === 'SINAL_EXPIRADO';

  const decisionConfig = isExpired
    ? {
        label: 'SINAL EXPIRADO — NÃO ENTRAR',
        icon: AlertTriangle,
        textClass: 'text-rose-600 dark:text-rose-400',
        surfaceClass: 'bg-rose-500/10 border-rose-500/30',
      }
    : isBuy
      ? {
          label: 'COMPRA (CALL)',
          icon: ArrowUpRight,
          textClass: 'text-emerald-600 dark:text-emerald-400',
          surfaceClass: 'bg-emerald-500/10 border-emerald-500/30',
        }
      : isSell
        ? {
            label: 'VENDA (PUT)',
            icon: ArrowDownRight,
            textClass: 'text-rose-600 dark:text-rose-400',
            surfaceClass: 'bg-rose-500/10 border-rose-500/30',
          }
        : {
            label: 'AGUARDAR',
            icon: Clock,
            textClass: 'text-amber-600 dark:text-amber-400',
            surfaceClass: 'bg-amber-500/10 border-amber-500/30',
          };

  const expectedDirectionLabel = isExpired
    ? 'INDEFINIDA'
    : isBuy
      ? 'SUBIDA'
      : isSell
        ? 'QUEDA'
        : analysis.expectedDirection || 'INDEFINIDA';

  const DecisionIcon = decisionConfig.icon;
  const hasComparativePct =
    typeof analysis.buyConfidencePct === 'number' || typeof analysis.sellConfidencePct === 'number';
  const bestDirLabel =
    analysis.bestDirection && analysis.bestDirection !== 'INDEFINIDA'
      ? analysis.bestDirection === 'COMPRA'
        ? 'COMPRA (CALL)'
        : 'VENDA (PUT)'
      : 'INDEFINIDA';

  const quickQuestions = isBuy || isSell
    ? ['Ainda posso entrar agora?', 'O sinal continua válido?', 'Qual o risco dessa operação?']
    : ['O mercado mudou agora?', 'Devo aguardar o próximo candle?'];

  return (
    <div className="space-y-3">
      {/* Decision & Metadata Header */}
      <div className={`rounded-2xl border p-4 ${decisionConfig.surfaceClass}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className={`flex items-center gap-2 font-display text-lg font-bold tracking-tight ${decisionConfig.textClass}`}>
            <DecisionIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>
              DECISÃO: {decisionConfig.label}
              {(isBuy || isSell) && !isExpired ? ' · ENTRADA CONSIDERÁVEL' : ''}
            </span>
          </div>
          {analysis.technicalConfidence !== null && !isExpired && (
            <span className="font-mono-tabular text-xs font-semibold text-slate-700 dark:text-slate-300">
              Confiança Estimada: {analysis.technicalConfidence}%
            </span>
          )}
        </div>

        {/* Comparative CALL vs PUT Confidence Row */}
        {hasComparativePct && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono-tabular">
            {typeof analysis.buyConfidencePct === 'number' && (
              <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                COMPRA (CALL): {analysis.buyConfidencePct}%
              </span>
            )}
            {typeof analysis.sellConfidencePct === 'number' && (
              <span className="font-semibold text-rose-700 dark:text-rose-400">
                VENDA (PUT): {analysis.sellConfidencePct}%
              </span>
            )}
            <span className="text-slate-600 dark:text-slate-400">
              Melhor direção: <strong className="text-slate-900 dark:text-slate-200">{bestDirLabel}</strong>
            </span>
          </div>
        )}

        {/* Unboxed clean metadata with typographic separators */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
          <span className="font-semibold text-slate-900 dark:text-slate-200">
            Direção: {expectedDirectionLabel}
          </span>
          <span aria-hidden="true">·</span>
          <span className="font-semibold text-slate-900 dark:text-slate-200">
            {analysis.asset || 'Ativo não identificado'}
          </span>
          <span aria-hidden="true">·</span>
          <span>Time frame: {formatTimeframeDisplay(analysis.timeframe)}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono-tabular">
            Análise {analysis.analysisTimeBrt} BRT
          </span>
        </div>
      </div>

      {/* Entry / Expiration & Price Grid (for COMPRA (CALL) / VENDA (PUT)) */}
      {(isBuy || isSell) && !isExpired && (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Horário de Entrada (Brasília)
            </div>
            <div className="mt-1 font-mono-tabular text-sm font-semibold text-slate-900 dark:text-slate-100">
              {analysis.entryWindowBrt || 'Aguardar confirmação'}
            </div>
            {analysis.timeRemainingToEntry && (
              <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {analysis.timeRemainingToEntry}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Expiração & Horário de Vencimento
            </div>
            <div className="mt-1 font-mono-tabular text-sm font-semibold text-slate-900 dark:text-slate-100">
              {analysis.exitWindowBrt || 'Condicional à expiração'}
            </div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Expiração da operação: {analysis.expirationDuration || analysis.signalValidity || '1 candle'}
              {analysis.expirationOptionsM1 && analysis.expirationOptionsM1.length > 1
                ? ` (M1: ${analysis.expirationOptionsM1.join(' / ')})`
                : ''}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Preço / Região de Entrada
            </div>
            <div className="mt-1 font-mono-tabular text-sm font-semibold text-slate-900 dark:text-slate-100">
              {analysis.entryPrice || 'Região técnica atual'}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Alvo Técnico & Invalidação
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono-tabular text-sm font-semibold">
              <span className="text-emerald-600 dark:text-emerald-400">
                Alvo: {analysis.targetPrice || '—'}
              </span>
              <span className="text-slate-400" aria-hidden="true">/</span>
              <span className="text-rose-600 dark:text-rose-400">
                Stop: {analysis.stopLoss || '—'}
              </span>
            </div>
          </div>
        </div>
      )}

      {analysis.needsClarification === 'NEW_PHOTO' && analysis.clarificationQuestion && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs font-medium text-amber-800 dark:text-amber-300">
          {analysis.clarificationQuestion}
        </div>
      )}

      {/* Live Market Quote & Freshness Verification */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/80 px-3.5 py-2.5 text-xs dark:border-slate-800 dark:bg-slate-900/50">
        {marketQuote && marketQuote.available ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <TrendingUp className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400" aria-hidden="true" />
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {marketQuote.displayName}
              </span>
              <span className="font-mono-tabular font-semibold text-slate-900 dark:text-slate-100">
                {marketQuote.price.toLocaleString('pt-BR', { maximumFractionDigits: 6 })} {marketQuote.currency}
              </span>
              {marketQuote.changePercent24h !== null && (
                <span
                  className={`font-mono-tabular font-medium ${
                    marketQuote.changePercent24h >= 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-rose-600 dark:text-rose-400'
                  }`}
                >
                  {marketQuote.changePercent24h >= 0 ? '+' : ''}
                  {marketQuote.changePercent24h.toFixed(2)}%
                </span>
              )}
            </div>
            <div className="font-mono-tabular text-slate-500 dark:text-slate-400">
              {marketQuote.provider} · {marketQuote.fetchedAtBrt} BRT
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{analysis.dataFreshnessNote}</span>
          </div>
        )}

        {analysis.dataFreshnessStatus === 'DEFASADO' && (
          <div className="mt-1.5 flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{analysis.dataFreshnessNote}</span>
          </div>
        )}
      </div>

      {/* Disclaimer line */}
      <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
        {analysis.confidenceDisclaimer ||
          'Horários são janelas técnicas condicionais sujeitas à volatilidade do mercado, sem garantia de resultado.'}{' '}
        Foto recebida às {analysis.photoReceivedAtBrt} BRT.
      </p>

      {/* Quick one-tap follow-up buttons */}
      {showQuickActions && onQuickFollowUp && (
        <div className="flex flex-wrap gap-2 pt-1">
          {quickQuestions.map((q) => (
            <button
              key={q}
              type="button"
              disabled={disabled}
              onClick={() => onQuickFollowUp(q)}
              className="min-h-[40px] rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 active:scale-[0.98] disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
