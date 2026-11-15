import { deleteConversationsByProject } from '../../server/conversationStore.ts';
import { authErrorResponse, verifyFirebaseIdTokenHeader } from '../../server/firebaseAuth.ts';
import {
  deleteProject,
  getProjectById,
  listProjects,
  saveProject,
} from '../../server/projectStore.ts';
import { assertNoTenantSpoofing, TenantAccessError } from '../../server/tenantRegistry.ts';

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

  const idParam = url.searchParams.get('id');
  const pathLast = url.pathname.split('/').filter(Boolean).pop();
  const targetId =
    idParam || (pathLast && pathLast !== 'projects' ? decodeURIComponent(pathLast) : undefined);

  try {
    if (req.method === 'GET') {
      if (targetId) {
        const project = await getProjectById(authUser, targetId);
        return Response.json({ project }, { headers: { 'Cache-Control': 'no-store, private' } });
      }
      const projects = await listProjects(authUser);
      return Response.json({ projects }, { headers: { 'Cache-Control': 'no-store, private' } });
    }

    if (req.method === 'POST') {
      const body = (await req.json()) as {
        id?: string;
        name?: string;
        description?: string;
        defaultAsset?: string | null;
        defaultTimeframe?: string | null;
        companyId?: string;
        ownerUid?: string;
        uid?: string;
      };
      assertNoTenantSpoofing(authUser, [body?.companyId], 'companyId');
      assertNoTenantSpoofing(authUser, [body?.ownerUid, body?.uid], 'uid');
      const project = await saveProject(authUser, {
        id: body?.id,
        name: body?.name || '',
        description: body?.description,
        defaultAsset: body?.defaultAsset,
        defaultTimeframe: body?.defaultTimeframe,
      });
      return Response.json({ project }, { headers: { 'Cache-Control': 'no-store, private' } });
    }

    if (req.method === 'DELETE') {
      if (!targetId) {
        return Response.json({ error: 'ID do projeto é obrigatório.' }, { status: 400 });
      }
      await deleteProject(authUser, targetId);
      await deleteConversationsByProject(authUser, targetId);
      return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, private' } });
    }

    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return authErrorResponse(err);
    }
    return Response.json(
      { error: err instanceof Error ? err.message : 'Erro ao gerenciar projetos.' },
      { status: 400, headers: { 'Cache-Control': 'no-store, private' } },
    );
  }
};
