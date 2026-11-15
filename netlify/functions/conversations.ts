import {
  deleteConversation,
  getConversationById,
  listConversations,
  saveConversation,
} from '../../server/conversationStore.ts';
import { authErrorResponse, verifyFirebaseIdTokenHeader } from '../../server/firebaseAuth.ts';
import { assertNoTenantSpoofing, TenantAccessError } from '../../server/tenantRegistry.ts';
import type { Conversation } from '../../shared/types.ts';

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
    idParam || (pathLast && pathLast !== 'conversations' ? decodeURIComponent(pathLast) : undefined);

  try {
    if (req.method === 'GET') {
      if (targetId) {
        const conversation = await getConversationById(authUser, targetId);
        return Response.json({ conversation }, { headers: { 'Cache-Control': 'no-store, private' } });
      }
      const projectId = url.searchParams.get('projectId') || undefined;
      const conversations = await listConversations(authUser, projectId);
      return Response.json({ conversations }, { headers: { 'Cache-Control': 'no-store, private' } });
    }

    if (req.method === 'POST') {
      const conv = (await req.json()) as Conversation;
      assertNoTenantSpoofing(authUser, [conv?.companyId], 'companyId');
      assertNoTenantSpoofing(authUser, [conv?.ownerUid], 'uid');
      if (!conv?.id) {
        return Response.json({ error: 'Conversa inválida.' }, { status: 400 });
      }
      const saved = await saveConversation(authUser, conv);
      return Response.json({ conversation: saved }, { headers: { 'Cache-Control': 'no-store, private' } });
    }

    if (req.method === 'DELETE') {
      if (!targetId) {
        return Response.json({ error: 'ID da conversa é obrigatório.' }, { status: 400 });
      }
      await deleteConversation(authUser, targetId);
      return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, private' } });
    }

    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return authErrorResponse(err);
    }
    return Response.json(
      { error: err instanceof Error ? err.message : 'Erro no histórico.' },
      { status: 500, headers: { 'Cache-Control': 'no-store, private' } },
    );
  }
};
