import {
  deleteConversation,
  getConversationById,
  listConversations,
  saveConversation,
} from '../../server/conversationStore.ts';
import { authErrorResponse, verifyFirebaseIdTokenHeader } from '../../server/firebaseAuth.ts';
import {
  API_SECURITY_HEADERS,
  enforceRateLimitOrThrow,
  getClientIpFromHeaders,
  parseJsonBodySafe,
  securityErrorResponse,
  SecurityValidationError,
} from '../../server/securityGuard.ts';
import { assertNoTenantSpoofing, TenantAccessError } from '../../server/tenantRegistry.ts';
import type { Conversation } from '../../shared/types.ts';

export default async (req: Request): Promise<Response> => {
  let authUser;
  const url = new URL(req.url);
  const ip = getClientIpFromHeaders((name) => req.headers.get(name));
  try {
    enforceRateLimitOrThrow({
      key: `nf:conv:ip:${ip}`,
      maxRequests: 120,
      windowMs: 60_000,
      route: '/api/conversations',
    });

    authUser = await verifyFirebaseIdTokenHeader(req.headers.get('authorization'));
    enforceRateLimitOrThrow({
      key: `nf:conv:uid:${authUser.uid}`,
      maxRequests: 90,
      windowMs: 60_000,
      route: '/api/conversations',
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
    idParam || (pathLast && pathLast !== 'conversations' ? decodeURIComponent(pathLast) : undefined);

  try {
    if (req.method === 'GET') {
      if (targetId) {
        const conversation = await getConversationById(authUser, targetId);
        return Response.json({ conversation }, { headers: API_SECURITY_HEADERS });
      }
      const projectId = url.searchParams.get('projectId') || undefined;
      const conversations = await listConversations(authUser, projectId);
      return Response.json({ conversations }, { headers: API_SECURITY_HEADERS });
    }

    if (req.method === 'POST') {
      const conv = await parseJsonBodySafe<Conversation>(req, 6 * 1024 * 1024);
      assertNoTenantSpoofing(authUser, [conv?.companyId], 'companyId');
      assertNoTenantSpoofing(authUser, [conv?.ownerUid], 'uid');
      if (!conv?.id) {
        return Response.json({ error: 'Conversa inválida.' }, { status: 400, headers: API_SECURITY_HEADERS });
      }
      const saved = await saveConversation(authUser, conv);
      return Response.json({ conversation: saved }, { headers: API_SECURITY_HEADERS });
    }

    if (req.method === 'DELETE') {
      if (!targetId) {
        return Response.json(
          { error: 'ID da conversa é obrigatório.' },
          { status: 400, headers: API_SECURITY_HEADERS },
        );
      }
      await deleteConversation(authUser, targetId);
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
      { error: err instanceof Error ? err.message : 'Erro no histórico.' },
      { status: 500, headers: API_SECURITY_HEADERS },
    );
  }
};
