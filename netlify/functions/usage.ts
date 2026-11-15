import { authErrorResponse, verifyFirebaseIdTokenHeader } from '../../server/firebaseAuth.ts';
import {
  API_SECURITY_HEADERS,
  enforceRateLimitOrThrow,
  getClientIpFromHeaders,
  securityErrorResponse,
  SecurityValidationError,
} from '../../server/securityGuard.ts';
import { assertNoTenantSpoofing } from '../../server/tenantRegistry.ts';
import { getUsageStats } from '../../server/usageTracker.ts';

export default async (req: Request): Promise<Response> => {
  let authUser;
  const url = new URL(req.url);
  const ip = getClientIpFromHeaders((name) => req.headers.get(name));
  try {
    enforceRateLimitOrThrow({
      key: `nf:usage:ip:${ip}`,
      maxRequests: 60,
      windowMs: 60_000,
      route: '/api/usage',
    });

    authUser = await verifyFirebaseIdTokenHeader(req.headers.get('authorization'));
    enforceRateLimitOrThrow({
      key: `nf:usage:uid:${authUser.uid}`,
      maxRequests: 60,
      windowMs: 60_000,
      route: '/api/usage',
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

  try {
    const usage = await getUsageStats({ uid: authUser.uid, companyId: authUser.companyId });
    return Response.json(usage, { headers: API_SECURITY_HEADERS });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Erro ao consultar consumo.' },
      { status: 500, headers: API_SECURITY_HEADERS },
    );
  }
};
