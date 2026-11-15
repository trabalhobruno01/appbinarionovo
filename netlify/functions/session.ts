import { authErrorResponse, verifyFirebaseIdTokenHeader } from '../../server/firebaseAuth.ts';
import { ensureDefaultProject } from '../../server/projectStore.ts';
import { assertNoTenantSpoofing } from '../../server/tenantRegistry.ts';

export default async (req: Request): Promise<Response> => {
  try {
    const authUser = await verifyFirebaseIdTokenHeader(req.headers.get('authorization'));
    const url = new URL(req.url);
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
      { headers: { 'Cache-Control': 'no-store, private' } },
    );
  } catch (err) {
    return authErrorResponse(err);
  }
};
