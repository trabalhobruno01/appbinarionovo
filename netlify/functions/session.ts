import { authErrorResponse, verifyFirebaseIdTokenHeader } from '../../server/firebaseAuth.ts';
import { ensureDefaultProject } from '../../server/projectStore.ts';
import {
  API_SECURITY_HEADERS,
  enforceRateLimitOrThrow,
  getClientIpFromHeaders,
  securityErrorResponse,
  SecurityValidationError,
} from '../../server/securityGuard.ts';
import { assertNoTenantSpoofing } from '../../server/tenantRegistry.ts';

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const ip = getClientIpFromHeaders((name) => req.headers.get(name));
  try {
    enforceRateLimitOrThrow({
      key: `nf:session:ip:${ip}`,
      maxRequests: 60,
      windowMs: 60_000,
      route: '/api/session',
    });

    const authUser = await verifyFirebaseIdTokenHeader(req.headers.get('authorization'));
    enforceRateLimitOrThrow({
      key: `nf:session:uid:${authUser.uid}`,
      maxRequests: 60,
      windowMs: 60_000,
      route: '/api/session',
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
    await ensureDefaultProject(authUser);
    return Response.json(
      {
        uid: authUser.uid,
        email: authUser.email,
        companyId: authUser.companyId,
      },
      { headers: API_SECURITY_HEADERS },
    );
  } catch (err) {
    if (err instanceof SecurityValidationError) return securityErrorResponse(err);
    return authErrorResponse(err);
  }
};
