import { continueChartChat } from '../../server/aiAnalyst.ts';
import { authErrorResponse, verifyFirebaseIdTokenHeader } from '../../server/firebaseAuth.ts';
import {
  assertNoTenantSpoofing,
  assertResourceOwnership,
  TenantAccessError,
} from '../../server/tenantRegistry.ts';
import { sanitizeErrorMessage } from '../../server/usageTracker.ts';
import type { ChatMessage } from '../../shared/types.ts';

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

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
    const body = (await req.json()) as {
      messages?: ChatMessage[];
      userMessage?: string;
      lastAsset?: string | null;
      lastTimeframe?: string | null;
      projectId?: string;
      conversationId?: string;
      companyId?: string;
      ownerUid?: string;
    };

    assertNoTenantSpoofing(authUser, [body.companyId], 'companyId');
    assertNoTenantSpoofing(authUser, [body.ownerUid], 'uid');

    if (body.projectId) {
      await assertResourceOwnership({
        kind: 'projects',
        resourceId: body.projectId,
        authUser,
        allowUnregistered: false,
      });
    }
    if (body.conversationId) {
      await assertResourceOwnership({
        kind: 'conversations',
        resourceId: body.conversationId,
        authUser,
        allowUnregistered: true,
      });
    }

    if (!body.userMessage || !body.userMessage.trim()) {
      return Response.json({ error: 'Mensagem vazia.' }, { status: 400 });
    }

    const result = await continueChartChat({
      messages: Array.isArray(body.messages) ? body.messages : [],
      userMessage: body.userMessage.trim(),
      lastAsset: body.lastAsset,
      lastTimeframe: body.lastTimeframe,
      tenant: {
        uid: authUser.uid,
        companyId: authUser.companyId,
        projectId: body.projectId,
        conversationId: body.conversationId,
      },
    });

    return Response.json(result, { headers: { 'Cache-Control': 'no-store, private' } });
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return authErrorResponse(err);
    }
    const rawMsg = err instanceof Error ? err.message : 'Erro no chat contextual.';
    const msg = sanitizeErrorMessage(rawMsg);
    const status = msg.includes('GEMINI_API_KEY') ? 503 : msg.includes('429') ? 429 : 500;
    return Response.json({ error: msg }, { status, headers: { 'Cache-Control': 'no-store, private' } });
  }
};
