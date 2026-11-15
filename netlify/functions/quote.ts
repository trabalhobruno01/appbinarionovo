import { authErrorResponse, verifyFirebaseIdTokenHeader } from '../../server/firebaseAuth.ts';
import { fetchMarketQuote } from '../../server/marketData.ts';
import {
  API_SECURITY_HEADERS,
  enforceRateLimitOrThrow,
  getClientIpFromHeaders,
  sanitizeSymbolInput,
  securityErrorResponse,
  SecurityValidationError,
} from '../../server/securityGuard.ts';
import { assertNoTenantSpoofing } from '../../server/tenantRegistry.ts';

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const ip = getClientIpFromHeaders((name) => req.headers.get(name));
  try {
    enforceRateLimitOrThrow({
      key: `nf:quote:ip:${ip}`,
      maxRequests: 90,
      windowMs: 60_000,
      route: '/api/quote',
    });
    const authUser = await verifyFirebaseIdTokenHeader(req.headers.get('authorization'));
    enforceRateLimitOrThrow({
      key: `nf:quote:uid:${authUser.uid}`,
      maxRequests: 60,
      windowMs: 60_000,
      route: '/api/quote',
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

  const symbol = sanitizeSymbolInput(url.searchParams.get('symbol'), 40);
  const timeframe = sanitizeSymbolInput(url.searchParams.get('timeframe') || '15m', 12) || '15m';

  if (!symbol) {
    return Response.json(
      { error: 'Parâmetro symbol é obrigatório.' },
      { status: 400, headers: API_SECURITY_HEADERS },
    );
  }

  try {
    const quote = await fetchMarketQuote(symbol, timeframe);
    return Response.json(quote, { headers: API_SECURITY_HEADERS });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Erro ao consultar cotação.' },
      { status: 500, headers: API_SECURITY_HEADERS },
    );
  }
};
