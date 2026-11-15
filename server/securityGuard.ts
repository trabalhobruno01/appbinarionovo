import { formatTimestampBrt } from './timeService.ts';

export class SecurityValidationError extends Error {
  readonly status: 400 | 401 | 403 | 413 | 429 | 504;

  constructor(status: 400 | 401 | 403 | 413 | 429 | 504, message: string) {
    super(message);
    this.status = status;
  }
}

interface RateWindow {
  count: number;
  resetAtMs: number;
}

const rateBuckets = new Map<string, RateWindow>();
let lastPruneAtMs = 0;

function pruneExpiredBuckets(now: number): void {
  if (now - lastPruneAtMs < 60_000 && rateBuckets.size < 2000) return;
  lastPruneAtMs = now;
  for (const [k, v] of rateBuckets.entries()) {
    if (v.resetAtMs <= now) {
      rateBuckets.delete(k);
    }
  }
}

export function checkRateLimit(params: {
  key: string;
  maxRequests: number;
  windowMs: number;
}): { allowed: boolean; remaining: number; retryAfterSec: number } {
  const now = Date.now();
  pruneExpiredBuckets(now);

  const existing = rateBuckets.get(params.key);
  if (!existing || existing.resetAtMs <= now) {
    rateBuckets.set(params.key, {
      count: 1,
      resetAtMs: now + params.windowMs,
    });
    return {
      allowed: true,
      remaining: Math.max(0, params.maxRequests - 1),
      retryAfterSec: 0,
    };
  }

  existing.count += 1;
  if (existing.count > params.maxRequests) {
    const retryAfterSec = Math.max(1, Math.ceil((existing.resetAtMs - now) / 1000));
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, params.maxRequests - existing.count),
    retryAfterSec: 0,
  };
}

export function enforceRateLimitOrThrow(params: {
  key: string;
  maxRequests: number;
  windowMs: number;
  route: string;
}): void {
  const result = checkRateLimit(params);
  if (!result.allowed) {
    logSecurityEvent('RATE_LIMIT_EXCEEDED', {
      route: params.route,
      retryAfterSec: result.retryAfterSec,
    });
    throw new SecurityValidationError(
      429,
      `Muitas requisições em sequência. Aguarde ${result.retryAfterSec}s e tente novamente.`,
    );
  }
}

export function getClientIpFromHeaders(
  getHeader: (name: string) => string | null | undefined,
  fallbackIp?: string,
): string {
  const netlifyIp = getHeader('x-nf-client-connection-ip')?.trim();
  if (netlifyIp) return netlifyIp.slice(0, 64);
  const forwarded = getHeader('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  const realIp = getHeader('x-real-ip')?.trim();
  if (realIp) return realIp.slice(0, 64);
  return (fallbackIp || 'unknown').slice(0, 64);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function assertSafePayload(
  value: unknown,
  options: { maxDepth?: number; maxArrayLength?: number; skipDataUrls?: boolean } = {},
  depth = 0,
): void {
  const maxDepth = options.maxDepth ?? 10;
  const maxArrayLength = options.maxArrayLength ?? 250;

  if (depth > maxDepth) {
    throw new SecurityValidationError(400, 'Estrutura de dados excede a profundidade permitida.');
  }
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > maxArrayLength) {
      throw new SecurityValidationError(400, 'Quantidade de itens enviada excede o limite seguro.');
    }
    for (const item of value) {
      assertSafePayload(item, options, depth + 1);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key) || key.startsWith('$') || key.includes('\u0000')) {
        logSecurityEvent('BLOCKED_INJECTION_KEY', { key: key.slice(0, 32) });
        throw new SecurityValidationError(400, 'Parâmetro inválido ou não permitido na requisição.');
      }
      assertSafePayload((value as Record<string, unknown>)[key], options, depth + 1);
    }
  }
}

export function verifyImageDataUrlMagicBytes(
  dataUrl: unknown,
  maxBytes = 5 * 1024 * 1024,
): { ok: true; mime: string } | { ok: false; error: string; status: 400 | 413 } {
  if (typeof dataUrl !== 'string') {
    return { ok: false, error: 'Formato de imagem inválido. Envie PNG, JPEG ou WebP.', status: 400 };
  }

  const match = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return {
      ok: false,
      error: 'Tipo de arquivo não suportado. Use apenas fotografia JPEG, PNG ou WebP.',
      status: 400,
    };
  }

  if (Buffer.byteLength(dataUrl, 'utf-8') > maxBytes) {
    return {
      ok: false,
      error: 'Imagem excede o limite de tamanho permitido após compressão.',
      status: 413,
    };
  }

  const declaredSubtype = match[1].toLowerCase();
  const base64Sample = match[2].replace(/\s+/g, '').slice(0, 64);
  if (!base64Sample) {
    return { ok: false, error: 'Imagem vazia ou corrompida.', status: 400 };
  }

  const headerBytes = Buffer.from(base64Sample, 'base64');
  if (headerBytes.length < 12) {
    return { ok: false, error: 'Arquivo de imagem inválido ou incompleto.', status: 400 };
  }

  const isJpeg = headerBytes[0] === 0xff && headerBytes[1] === 0xd8 && headerBytes[2] === 0xff;
  const isPng =
    headerBytes[0] === 0x89 &&
    headerBytes[1] === 0x50 &&
    headerBytes[2] === 0x4e &&
    headerBytes[3] === 0x47 &&
    headerBytes[4] === 0x0d &&
    headerBytes[5] === 0x0a &&
    headerBytes[6] === 0x1a &&
    headerBytes[7] === 0x0a;
  const isWebp =
    headerBytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    headerBytes.subarray(8, 12).toString('ascii') === 'WEBP';

  const matchesDeclared =
    ((declaredSubtype === 'jpeg' || declaredSubtype === 'jpg') && isJpeg) ||
    (declaredSubtype === 'png' && isPng) ||
    (declaredSubtype === 'webp' && isWebp);

  if (!matchesDeclared && !(isJpeg || isPng || isWebp)) {
    logSecurityEvent('BLOCKED_INVALID_IMAGE_UPLOAD', { declaredSubtype });
    return {
      ok: false,
      error: 'Conteúdo do arquivo não corresponde a uma imagem JPEG, PNG ou WebP válida.',
      status: 400,
    };
  }

  return { ok: true, mime: `image/${declaredSubtype === 'jpg' ? 'jpeg' : declaredSubtype}` };
}

export function sanitizeSymbolInput(raw: unknown, maxLen = 40): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001F\u007F<>`"'\\;]/g, '')
    .trim()
    .slice(0, maxLen);
}

export async function parseJsonBodySafe<T>(req: Request, maxBytes = 6 * 1024 * 1024): Promise<T> {
  const contentLength = Number(req.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new SecurityValidationError(413, 'Payload excede o tamanho máximo permitido.');
  }

  const rawText = await req.text();
  if (Buffer.byteLength(rawText, 'utf-8') > maxBytes) {
    throw new SecurityValidationError(413, 'Payload excede o tamanho máximo permitido.');
  }
  if (!rawText.trim()) {
    throw new SecurityValidationError(400, 'Corpo JSON ausente ou vazio.');
  }

  try {
    const parsed = JSON.parse(rawText) as T;
    assertSafePayload(parsed);
    return parsed;
  } catch (err) {
    if (err instanceof SecurityValidationError) throw err;
    throw new SecurityValidationError(400, 'JSON inválido na requisição.');
  }
}

export const API_SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export function securityErrorResponse(err: SecurityValidationError): Response {
  return Response.json(
    { error: err.message },
    {
      status: err.status,
      headers: API_SECURITY_HEADERS,
    },
  );
}

export function logSecurityEvent(
  event: string,
  meta: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const brt = formatTimestampBrt(Date.now());
  const safeMeta: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    const str = String(v)
      .replace(/Bearer\s+[^\s]+/gi, '[REDACTED]')
      .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[REDACTED]')
      .slice(0, 96);
    safeMeta[k] = typeof v === 'number' || typeof v === 'boolean' ? v : str;
  }
  console.warn(`[SEC ${brt.isoBrt}] ${event}`, JSON.stringify(safeMeta));
}
