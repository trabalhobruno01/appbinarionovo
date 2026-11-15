import { authErrorResponse, verifyFirebaseIdTokenHeader } from '../../server/firebaseAuth.ts';
import {
  API_SECURITY_HEADERS,
  assertSafePayload,
  enforceRateLimitOrThrow,
  getClientIpFromHeaders,
  sanitizeSymbolInput,
  securityErrorResponse,
  SecurityValidationError,
} from '../../server/securityGuard.ts';
import {
  DEFAULT_PAYOUT_PERCENT,
  DEFAULT_TIE_RULE,
  getValidationSummary,
  runCausalWalkForwardBacktest,
  settlePendingSignals,
} from '../../server/signalValidator.ts';
import { assertNoTenantSpoofing, TenantAccessError } from '../../server/tenantRegistry.ts';
import { sanitizeErrorMessage } from '../../server/usageTracker.ts';
import type { TieRule } from '../../shared/types.ts';

export default async (req: Request): Promise<Response> => {
  let authUser;
  const url = new URL(req.url);
  const ip = getClientIpFromHeaders((name) => req.headers.get(name));
  try {
    enforceRateLimitOrThrow({
      key: `nf:signals:ip:${ip}`,
      maxRequests: 60,
      windowMs: 60_000,
      route: '/api/signals',
    });

    authUser = await verifyFirebaseIdTokenHeader(req.headers.get('authorization'));
    enforceRateLimitOrThrow({
      key: `nf:signals:uid:${authUser.uid}`,
      maxRequests: 40,
      windowMs: 60_000,
      route: '/api/signals',
    });

    assertNoTenantSpoofing(
      authUser,
      [req.headers.get('x-company-id'), url.searchParams.get('companyId')],
      'companyId',
    );
    assertNoTenantSpoofing(
      authUser,
      [req.headers.get('x-owner-uid'), url.searchParams.get('ownerUid'), url.searchParams.get('uid')],
      'uid',
    );
  } catch (err) {
    if (err instanceof SecurityValidationError) return securityErrorResponse(err);
    return authErrorResponse(err);
  }

  const tenant = { uid: authUser.uid, companyId: authUser.companyId };
  const path = url.pathname;

  try {
    if (req.method === 'GET') {
      const payout = Number(url.searchParams.get('payout')) || DEFAULT_PAYOUT_PERCENT;
      const tieRule: TieRule = url.searchParams.get('tieRule') === 'LOSS' ? 'LOSS' : DEFAULT_TIE_RULE;
      const settle = url.searchParams.get('settle') !== 'false';
      const summary = await getValidationSummary(payout, tieRule, settle, tenant);
      return Response.json(summary, { headers: API_SECURITY_HEADERS });
    }

    if (req.method === 'POST' && path.endsWith('/settle')) {
      const body = (await req.json().catch(() => ({}))) as { payoutPercent?: number; tieRule?: TieRule };
      assertSafePayload(body);
      const payout = Number(body.payoutPercent) || DEFAULT_PAYOUT_PERCENT;
      const tieRule: TieRule = body.tieRule === 'LOSS' ? 'LOSS' : DEFAULT_TIE_RULE;
      const settled = await settlePendingSignals(payout, tieRule, tenant);
      const summary = await getValidationSummary(payout, tieRule, false, tenant);
      return Response.json({ ...settled, summary }, { headers: API_SECURITY_HEADERS });
    }

    if (req.method === 'POST' && path.endsWith('/backtest')) {
      const body = (await req.json().catch(() => ({}))) as {
        symbol?: string;
        timeframe?: string;
        expirationBars?: number;
        payoutPercent?: number;
        tieRule?: TieRule;
      };
      assertSafePayload(body);
      const result = await runCausalWalkForwardBacktest({
        symbol: sanitizeSymbolInput(body.symbol || 'BTCUSDT', 40) || 'BTCUSDT',
        timeframe: sanitizeSymbolInput(body.timeframe || '15m', 12) || '15m',
        expirationBars: Math.min(20, Math.max(1, Number(body.expirationBars) || 1)),
        payoutPercent: Number(body.payoutPercent) || DEFAULT_PAYOUT_PERCENT,
        tieRule: body.tieRule === 'LOSS' ? 'LOSS' : DEFAULT_TIE_RULE,
      });
      return Response.json(result, { headers: API_SECURITY_HEADERS });
    }

    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: API_SECURITY_HEADERS });
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return authErrorResponse(err);
    }
    if (err instanceof SecurityValidationError) {
      return securityErrorResponse(err);
    }
    const msg = err instanceof Error ? sanitizeErrorMessage(err.message) : 'Erro na validação de sinais.';
    return Response.json({ error: msg }, { status: 400, headers: API_SECURITY_HEADERS });
  }
};
