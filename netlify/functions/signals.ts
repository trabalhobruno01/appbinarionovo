import {
  DEFAULT_PAYOUT_PERCENT,
  DEFAULT_TIE_RULE,
  getValidationSummary,
  runCausalWalkForwardBacktest,
  settlePendingSignals,
} from '../../server/signalValidator.ts';
import { sanitizeErrorMessage } from '../../server/usageTracker.ts';
import type { TieRule } from '../../shared/types.ts';

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const path = url.pathname;

  try {
    if (req.method === 'GET') {
      const payout = Number(url.searchParams.get('payout')) || DEFAULT_PAYOUT_PERCENT;
      const tieRule: TieRule = url.searchParams.get('tieRule') === 'LOSS' ? 'LOSS' : DEFAULT_TIE_RULE;
      const settle = url.searchParams.get('settle') !== 'false';
      const summary = await getValidationSummary(payout, tieRule, settle);
      return Response.json(summary, { headers: { 'Cache-Control': 'no-store, private' } });
    }

    if (req.method === 'POST' && path.endsWith('/settle')) {
      const body = (await req.json().catch(() => ({}))) as { payoutPercent?: number; tieRule?: TieRule };
      const payout = Number(body.payoutPercent) || DEFAULT_PAYOUT_PERCENT;
      const tieRule: TieRule = body.tieRule === 'LOSS' ? 'LOSS' : DEFAULT_TIE_RULE;
      const settled = await settlePendingSignals(payout, tieRule);
      const summary = await getValidationSummary(payout, tieRule, false);
      return Response.json({ ...settled, summary }, { headers: { 'Cache-Control': 'no-store, private' } });
    }

    if (req.method === 'POST' && path.endsWith('/backtest')) {
      const body = (await req.json().catch(() => ({}))) as {
        symbol?: string;
        timeframe?: string;
        expirationBars?: number;
        payoutPercent?: number;
        tieRule?: TieRule;
      };
      const result = await runCausalWalkForwardBacktest({
        symbol: (body.symbol || 'BTCUSDT').trim(),
        timeframe: body.timeframe || '15m',
        expirationBars: Number(body.expirationBars) || 1,
        payoutPercent: Number(body.payoutPercent) || DEFAULT_PAYOUT_PERCENT,
        tieRule: body.tieRule === 'LOSS' ? 'LOSS' : DEFAULT_TIE_RULE,
      });
      return Response.json(result, { headers: { 'Cache-Control': 'no-store, private' } });
    }

    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err) {
    const msg = err instanceof Error ? sanitizeErrorMessage(err.message) : 'Erro na validação de sinais.';
    return Response.json({ error: msg }, { status: 400, headers: { 'Cache-Control': 'no-store, private' } });
  }
};
