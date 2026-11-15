import { useEffect, useState } from 'react';
import { Activity, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type {
  SignalValidationSummary,
  TieRule,
  WalkForwardBacktestResult,
} from '../../shared/types.ts';
import {
  fetchSignalAudit,
  runHistoricalBacktest,
  settleExpiredSignals,
} from '../services/api.ts';

interface SignalAuditModalProps {
  open: boolean;
  onClose: () => void;
}

export function SignalAuditModal({ open, onClose }: SignalAuditModalProps) {
  const [payout, setPayout] = useState(80);
  const [tieRule, setTieRule] = useState<TieRule>('REFUND');
  const [summary, setSummary] = useState<SignalValidationSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [settling, setSettling] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [btSymbol, setBtSymbol] = useState('BTCUSDT');
  const [btTimeframe, setBtTimeframe] = useState('15m');
  const [btExpBars, setBtExpBars] = useState(1);
  const [btLoading, setBtLoading] = useState(false);
  const [backtest, setBacktest] = useState<WalkForwardBacktestResult | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setErrorMsg(null);
    fetchSignalAudit(payout, tieRule)
      .then((data) => {
        if (active) setSummary(data);
      })
      .catch((err) => {
        if (active) setErrorMsg(err instanceof Error ? err.message : 'Erro ao carregar auditoria.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, payout, tieRule]);

  if (!open) return null;

  async function handleSettle() {
    setSettling(true);
    setErrorMsg(null);
    try {
      const res = await settleExpiredSignals(payout, tieRule);
      setSummary(res.summary);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao verificar vencimentos.');
    } finally {
      setSettling(false);
    }
  }

  async function handleRunBacktest() {
    setBtLoading(true);
    setErrorMsg(null);
    try {
      const res = await runHistoricalBacktest({
        symbol: btSymbol,
        timeframe: btTimeframe,
        expirationBars: btExpBars,
        payoutPercent: payout,
        tieRule,
      });
      setBacktest(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro no teste histórico.');
    } finally {
      setBtLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-xs sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Auditoria independente de sinais"
    >
      <div className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl border border-slate-200 bg-white text-slate-900 shadow-2xl sm:rounded-2xl dark:border-slate-800 dark:bg-[#0F141E] dark:text-slate-100">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="flex items-center gap-2.5 min-w-0">
            <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <h2 className="font-display text-base font-bold truncate">
              Auditoria e Validação de Sinais
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar auditoria"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Payout & Tie Rules */}
          <div className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-3 dark:border-slate-800 dark:bg-slate-900/50">
            <label className="space-y-1 text-xs">
              <span className="font-medium text-slate-600 dark:text-slate-400">
                Payout da Corretora (%)
              </span>
              <input
                type="number"
                min={50}
                max={99}
                value={payout}
                onChange={(e) => setPayout(Math.max(50, Math.min(99, Number(e.target.value) || 80)))}
                className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 font-mono-tabular text-sm font-semibold text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="font-medium text-slate-600 dark:text-slate-400">
                Regra de Empate (0x0)
              </span>
              <select
                value={tieRule}
                onChange={(e) => setTieRule(e.target.value === 'LOSS' ? 'LOSS' : 'REFUND')}
                className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              >
                <option value="REFUND">Devolve entrada (0.00)</option>
                <option value="LOSS">Conta como perda (-1.00)</option>
              </select>
            </label>

            <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white px-3 py-2.5 dark:border-slate-800 dark:bg-slate-950">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Taxa Mínima de Equilíbrio
              </span>
              <span className="font-mono-tabular text-base font-bold text-slate-900 dark:text-slate-100">
                {((100 / (100 + payout)) * 100).toFixed(2)}%
              </span>
            </div>
          </div>

          {errorMsg && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs font-medium text-rose-700 dark:text-rose-300">
              {errorMsg}
            </div>
          )}

          {/* Live / Demo Signal Ledger Summary */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-display text-sm font-bold">
                  Registro Real de Sinais Emitidos
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Sinais não vencidos permanecem pendentes. Nenhuma ordem automática é executada.
                </p>
              </div>
              <button
                type="button"
                onClick={handleSettle}
                disabled={settling || loading}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-900 hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap shrink-0 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
              >
                <RefreshCw className={`h-4 w-4 ${settling ? 'animate-spin' : ''}`} />
                <span>Verificar Vencimentos</span>
              </button>
            </div>

            {loading ? (
              <p className="text-xs text-slate-500">Carregando registro independente...</p>
            ) : summary ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Operações</div>
                    <div className="mt-1 font-mono-tabular text-lg font-bold">
                      {summary.totalSignals}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {summary.pendingSignals} pendente(s)
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Placar Liquidado</div>
                    <div className="mt-1 font-mono-tabular text-lg font-bold">
                      {summary.wins}V · {summary.losses}D · {summary.ties}E
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {summary.decidedSignals} decididas
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Taxa de Acerto</div>
                    <div className="mt-1 font-mono-tabular text-lg font-bold">
                      {summary.winRatePct !== null ? `${summary.winRatePct}%` : 'Amostra insuf.'}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Mínimo: {summary.minSampleRequired}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Líquido Estimado</div>
                    <div className="mt-1 font-mono-tabular text-lg font-bold">
                      {summary.netUnits >= 0 ? '+' : ''}
                      {summary.netUnits.toFixed(2)} u
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Base 1 unidade/entrada
                    </div>
                  </div>
                </div>

                {summary.insufficientSampleMessage && (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
                    {summary.insufficientSampleMessage}
                  </div>
                )}

                {summary.signals.length > 0 && (
                  <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
                        <tr>
                          <th className="px-3 py-2.5 font-semibold">Ativo</th>
                          <th className="px-3 py-2.5 font-semibold">Dir.</th>
                          <th className="px-3 py-2.5 font-semibold">Entrada</th>
                          <th className="px-3 py-2.5 font-semibold">Vencimento</th>
                          <th className="px-3 py-2.5 font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 font-mono-tabular dark:divide-slate-800">
                        {summary.signals.slice(0, 15).map((s) => (
                          <tr key={s.id}>
                            <td className="px-3 py-2 font-sans font-medium">
                              {s.asset} · {s.timeframe}
                            </td>
                            <td className="px-3 py-2">{s.direction}</td>
                            <td className="px-3 py-2">
                              {s.entryTimeBrt.split(' ')[1]} ({s.entryPrice ?? '—'})
                            </td>
                            <td className="px-3 py-2">
                              {s.expiryTimeBrt.split(' ')[1]} ({s.expiryPrice ?? '—'})
                            </td>
                            <td className="px-3 py-2 font-sans font-semibold">{s.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : null}
          </section>

          {/* Causal Walk-Forward Backtester */}
          <section className="space-y-3 border-t border-slate-200 pt-5 dark:border-slate-800">
            <div>
              <h3 className="font-display text-sm font-bold">
                Teste Histórico Causal (Sem Vazamento Futuro)
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Avalia a regra técnica determinística em candles reais (Yahoo Finance) sem usar a API Gemini e sem olhar barras futuras. Validação prévia antes de conta demo.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-4">
              <input
                type="text"
                value={btSymbol}
                onChange={(e) => setBtSymbol(e.target.value.toUpperCase())}
                placeholder="Ex: BTCUSDT, PETR4"
                aria-label="Ativo para backtest histórico"
                className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium dark:border-slate-700 dark:bg-slate-950"
              />
              <select
                value={btTimeframe}
                onChange={(e) => setBtTimeframe(e.target.value)}
                aria-label="Timeframe do backtest"
                className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
              >
                <option value="5m">5 minutos</option>
                <option value="15m">15 minutos</option>
                <option value="1h">1 hora</option>
              </select>
              <select
                value={btExpBars}
                onChange={(e) => setBtExpBars(Number(e.target.value))}
                aria-label="Expiração em candles"
                className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
              >
                <option value={1}>Expiração: 1 candle</option>
                <option value={2}>Expiração: 2 candles</option>
                <option value={3}>Expiração: 3 candles</option>
              </select>
              <button
                type="button"
                onClick={handleRunBacktest}
                disabled={btLoading}
                className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50 whitespace-nowrap"
              >
                <Activity className="h-4 w-4" />
                <span>{btLoading ? 'Testando...' : 'Executar Walk-Forward'}</span>
              </button>
            </div>

            {backtest && (
              <div className="space-y-2.5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-900/50">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    {backtest.displayName} ({backtest.timeframe})
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{backtest.periodStartBrt} até {backtest.periodEndBrt}</span>
                  <span aria-hidden="true">·</span>
                  <span>{backtest.totalBarsEvaluated} candles</span>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 font-mono-tabular">
                  <div>
                    <span className="text-slate-500">Sinais:</span>{' '}
                    <strong>{backtest.totalSignals}</strong> ({backtest.wins}V/{backtest.losses}D/{backtest.ties}E)
                  </div>
                  <div>
                    <span className="text-slate-500">Acerto:</span>{' '}
                    <strong>{backtest.winRatePct !== null ? `${backtest.winRatePct}%` : 'Amostra insuf.'}</strong>
                  </div>
                  <div>
                    <span className="text-slate-500">Break-even:</span>{' '}
                    <strong>{backtest.breakEvenWinRatePct}%</strong>
                  </div>
                  <div>
                    <span className="text-slate-500">Líquido:</span>{' '}
                    <strong>{backtest.netUnits >= 0 ? '+' : ''}{backtest.netUnits} u</strong>
                  </div>
                </div>

                {backtest.insufficientSampleMessage && (
                  <p className="text-amber-700 dark:text-amber-300 font-medium">
                    {backtest.insufficientSampleMessage}
                  </p>
                )}

                <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  {backtest.disclaimer}
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
