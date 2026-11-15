import { deleteConversationsByProject } from '../../server/conversationStore.ts';
import { authErrorResponse, verifyFirebaseIdTokenHeader } from '../../server/firebaseAuth.ts';
import {
  deleteProject,
  getProjectById,
  listProjects,
  saveProject,
} from '../../server/projectStore.ts';
import {
  API_SECURITY_HEADERS,
  enforceRateLimitOrThrow,
  getClientIpFromHeaders,
  parseJsonBodySafe,
  securityErrorResponse,
  SecurityValidationError,
} from '../../server/securityGuard.ts';
import { assertNoTenantSpoofing, TenantAccessError } from '../../server/tenantRegistry.ts';

export default async (req: Request): Promise<Response> => {
  let authUser;
  const url = new URL(req.url);
  const ip = getClientIpFromHeaders((name) => req.headers.get(name));
  try {
    enforceRateLimitOrThrow({
      key: `nf:projects:ip:${ip}`,
      maxRequests: 90,
      windowMs: 60_000,
      route: '/api/projects',
    });

    authUser = await verifyFirebaseIdTokenHeader(req.headers.get('authorization'));
    enforceRateLimitOrThrow({
      key: `nf:projects:uid:${authUser.uid}`,
      maxRequests: 60,
      windowMs: 60_000,
      route: '/api/projects',
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

  const idParam = url.searchParams.get('id');
  const pathLast = url.pathname.split('/').filter(Boolean).pop();
  const targetId =
    idParam || (pathLast && pathLast !== 'projects' ? decodeURIComponent(pathLast) : undefined);

  try {
    if (req.method === 'GET') {
      if (targetId) {
        const project = await getProjectById(authUser, targetId);
        return Response.json({ project }, { headers: API_SECURITY_HEADERS });
      }
      const projects = await listProjects(authUser);
      return Response.json({ projects }, { headers: API_SECURITY_HEADERS });
    }

    if (req.method === 'POST') {
      const body = await parseJsonBodySafe<{
        id?: string;
        name?: string;
        description?: string;
        defaultAsset?: string | null;
        defaultTimeframe?: string | null;
        companyId?: string;
        ownerUid?: string;
        uid?: string;
      }>(req, 64 * 1024);
      assertNoTenantSpoofing(authUser, [body?.companyId], 'companyId');
      assertNoTenantSpoofing(authUser, [body?.ownerUid, body?.uid], 'uid');
      const project = await saveProject(authUser, {
        id: body?.id,
        name: body?.name || '',
        description: body?.description,
        defaultAsset: body?.defaultAsset,
        defaultTimeframe: body?.defaultTimeframe,
      });
      return Response.json({ project }, { headers: API_SECURITY_HEADERS });
    }

    if (req.method === 'DELETE') {
      if (!targetId) {
        return Response.json(
          { error: 'ID do projeto é obrigatório.' },
          { status: 400, headers: API_SECURITY_HEADERS },
        );
      }
      await deleteProject(authUser, targetId);
      await deleteConversationsByProject(authUser, targetId);
      return Response.json({ ok: true }, { headers: API_SECURITY_HEADERS });
    }

    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: API_SECURITY_HEADERS });
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return authErrorResponse(err);
    }
    if (err instanceof SecurityValidationError) {
      return securityErrorResponse(err);
    }
    return Response.json(
      { error: err instanceof Error ? err.message : 'Erro ao gerenciar projetos.' },
      { status: 400, headers: API_SECURITY_HEADERS },
    );
  }
};
