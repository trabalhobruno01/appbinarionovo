import { authErrorResponse, verifyFirebaseIdTokenHeader } from '../../server/firebaseAuth.ts';
import { assertNoTenantSpoofing } from '../../server/tenantRegistry.ts';
import { getUsageStats } from '../../server/usageTracker.ts';

export default async (req: Request): Promise<Response> => {
  let authUser;
  const url = new URL(req.url);
  try {
    authUser = await verifyFirebaseIdTokenHeader(req.headers.get('authorization'));
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
    return authErrorResponse(err);
  }

  try {
    const usage = await getUsageStats({ uid: authUser.uid, companyId: authUser.companyId });
    return Response.json(usage, { headers: { 'Cache-Control': 'no-store, private' } });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Erro ao consultar consumo.' },
      { status: 500, headers: { 'Cache-Control': 'no-store, private' } },
    );
  }
};
