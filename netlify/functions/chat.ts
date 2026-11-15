import { continueChartChat } from '../../server/aiAnalyst.ts';
import { authErrorResponse, verifyFirebaseIdTokenHeader } from '../../server/firebaseAuth.ts';
import { ensureAuthorizedProjectForTenant } from '../../server/projectStore.ts';
import {
  API_SECURITY_HEADERS,
  enforceRateLimitOrThrow,
  getClientIpFromHeaders,
  parseJsonBodySafe,
  securityErrorResponse,
  SecurityValidationError,
} from '../../server/securityGuard.ts';
import {
  assertNoTenantSpoofing,
  assertResourceOwnership,
  registerResourceOwnership,
  TenantAccessError,
} from '../../server/tenantRegistry.ts';
import { sanitizeErrorMessage } from '../../server/usageTracker.ts';
import type { ChatMessage } from '../../shared/types.ts';

const NETLIFY_TIMEOUT_MS = Number(process.env.NETLIFY_FUNCTION_TIMEOUT_MS) || 24_000;

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: API_SECURITY_HEADERS });
  }

  let authUser;
  const url = new URL(req.url);
  const ip = getClientIpFromHeaders((name) => req.headers.get(name));
  try {
    enforceRateLimitOrThrow({
      key: `nf:chat:ip:${ip}`,
      maxRequests: 45,
      windowMs: 60_000,
      route: '/api/chat',
    });

    authUser = await verifyFirebaseIdTokenHeader(req.headers.get('authorization'));
    enforceRateLimitOrThrow({
      key: `nf:chat:uid:${authUser.companyId}:${authUser.uid}`,
      maxRequests: 35,
      windowMs: 60_000,
      route: '/api/chat',
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
    const body = await parseJsonBodySafe<{
      messages?: ChatMessage[];
      userMessage?: string;
      lastAsset?: string | null;
      lastTimeframe?: string | null;
      projectId?: string;
      conversationId?: string;
      companyId?: string;
      ownerUid?: string;
    }>(req, 6 * 1024 * 1024);

    assertNoTenantSpoofing(authUser, [body.companyId], 'companyId');
    assertNoTenantSpoofing(authUser, [body.ownerUid], 'uid');

    const resolvedProject = await ensureAuthorizedProjectForTenant(authUser, body.projectId);
    if (body.conversationId) {
      await assertResourceOwnership({
        kind: 'conversations',
        resourceId: body.conversationId,
        authUser,
        allowUnregistered: true,
      });
      await registerResourceOwnership({
        kind: 'conversations',
        resourceId: body.conversationId,
        authUser,
        projectId: resolvedProject.id,
      });
    }

    if (!body.userMessage || typeof body.userMessage !== 'string' || !body.userMessage.trim()) {
      return Response.json({ error: 'Mensagem vazia.' }, { status: 400, headers: API_SECURITY_HEADERS });
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new SecurityValidationError(504, 'Tempo limite excedido na resposta da IA. Tente novamente.')),
        NETLIFY_TIMEOUT_MS,
      ),
    );

    const result = await Promise.race([
      continueChartChat({
        messages: Array.isArray(body.messages) ? body.messages.slice(-50) : [],
        userMessage: body.userMessage.trim().slice(0, 4000),
        lastAsset: body.lastAsset,
        lastTimeframe: body.lastTimeframe,
        tenant: {
          uid: authUser.uid,
          companyId: authUser.companyId,
          projectId: resolvedProject.id,
          conversationId: body.conversationId,
        },
      }),
      timeoutPromise,
    ]);

    return Response.json(result, { headers: API_SECURITY_HEADERS });
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return authErrorResponse(err);
    }
    if (err instanceof SecurityValidationError) {
      return securityErrorResponse(err);
    }
    const rawMsg = err instanceof Error ? err.message : 'Erro no chat contextual.';
    const msg = sanitizeErrorMessage(rawMsg);
    const status = msg.includes('GEMINI_API_KEY') ? 503 : msg.includes('429') ? 429 : 500;
    return Response.json({ error: msg }, { status, headers: API_SECURITY_HEADERS });
  }
};
