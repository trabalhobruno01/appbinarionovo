import { analyzeChartImage } from '../../server/aiAnalyst.ts';
import { authErrorResponse, verifyFirebaseIdTokenHeader } from '../../server/firebaseAuth.ts';
import {
  API_SECURITY_HEADERS,
  enforceRateLimitOrThrow,
  getClientIpFromHeaders,
  parseJsonBodySafe,
  securityErrorResponse,
  SecurityValidationError,
  verifyImageDataUrlMagicBytes,
} from '../../server/securityGuard.ts';
import {
  assertNoTenantSpoofing,
  assertResourceOwnership,
  TenantAccessError,
} from '../../server/tenantRegistry.ts';
import { sanitizeErrorMessage } from '../../server/usageTracker.ts';
import type { ChatMessage } from '../../shared/types.ts';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
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
      key: `nf:analyze:ip:${ip}`,
      maxRequests: 30,
      windowMs: 60_000,
      route: '/api/analyze',
    });

    authUser = await verifyFirebaseIdTokenHeader(req.headers.get('authorization'));
    enforceRateLimitOrThrow({
      key: `nf:analyze:uid:${authUser.uid}`,
      maxRequests: 20,
      windowMs: 60_000,
      route: '/api/analyze',
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
      imageDataUrl?: string;
      userMessage?: string;
      photoReceivedAtBrt?: string;
      history?: ChatMessage[];
      projectId?: string;
      conversationId?: string;
      companyId?: string;
      ownerUid?: string;
    }>(req, 6 * 1024 * 1024);

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

    const imageCheck = verifyImageDataUrlMagicBytes(body.imageDataUrl, MAX_IMAGE_BYTES);
    if (imageCheck.ok === false) {
      return Response.json(
        { error: imageCheck.error },
        { status: imageCheck.status, headers: API_SECURITY_HEADERS },
      );
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new SecurityValidationError(504, 'Tempo limite excedido ao analisar gráfico. Tente novamente.')),
        NETLIFY_TIMEOUT_MS,
      ),
    );

    const result = await Promise.race([
      analyzeChartImage({
        imageDataUrl: body.imageDataUrl!,
        userMessage: typeof body.userMessage === 'string' ? body.userMessage.slice(0, 2000) : undefined,
        photoReceivedAtBrt: body.photoReceivedAtBrt,
        history: Array.isArray(body.history) ? body.history.slice(-40) : undefined,
        tenant: {
          uid: authUser.uid,
          companyId: authUser.companyId,
          projectId: body.projectId,
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
    const rawMsg = err instanceof Error ? err.message : 'Erro ao analisar gráfico.';
    const msg = sanitizeErrorMessage(rawMsg);
    const status = msg.includes('GEMINI_API_KEY') ? 503 : msg.includes('429') ? 429 : 500;
    return Response.json({ error: msg }, { status, headers: API_SECURITY_HEADERS });
  }
};
