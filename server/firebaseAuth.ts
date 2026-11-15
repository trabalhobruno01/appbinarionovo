import crypto from 'node:crypto';
import type { App, ServiceAccount } from 'firebase-admin/app';
import type { DecodedIdToken } from 'firebase-admin/auth';
import appletConfig from '../firebase-applet-config.json' with { type: 'json' };
import { API_SECURITY_HEADERS, logSecurityEvent } from './securityGuard.ts';
import { resolveUserTenant, TenantAccessError } from './tenantRegistry.ts';

export interface VerifiedFirebaseUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  companyId: string;
}

export class AuthVerificationError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.status = status;
  }
}

const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let cachedCerts: Record<string, string> = {};
let certsExpiresAtMs = 0;

function resolveProjectId(): string {
  return (
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.VITE_FIREBASE_PROJECT_ID?.trim() ||
    appletConfig.projectId
  );
}

function resolveServiceAccount(): ServiceAccount | null {
  const jsonRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw) as {
        project_id?: string;
        projectId?: string;
        client_email?: string;
        clientEmail?: string;
        private_key?: string;
        privateKey?: string;
      };
      const projectId = parsed.project_id || parsed.projectId || resolveProjectId();
      const clientEmail = parsed.client_email || parsed.clientEmail;
      const privateKey = (parsed.private_key || parsed.privateKey)?.replace(/\\n/g, '\n');
      if (projectId && clientEmail && privateKey) {
        return { projectId, clientEmail, privateKey };
      }
    } catch {
      // Ignore malformed service account JSON; avoid logging secret content
    }
  }

  const projectId = resolveProjectId();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey };
  }

  return null;
}

async function getAdminAppIfConfigured(): Promise<App | null> {
  const sa = resolveServiceAccount();
  if (!sa) return null;

  const { cert, getApps, initializeApp } = await import('firebase-admin/app');
  const existing = getApps().find((a) => a.name === 'chartpulse-admin');
  if (existing) return existing;

  return initializeApp(
    {
      credential: cert(sa),
      projectId: sa.projectId,
    },
    'chartpulse-admin',
  );
}

async function fetchGooglePublicCerts(forceRefresh = false): Promise<Record<string, string>> {
  const now = Date.now();
  if (!forceRefresh && certsExpiresAtMs > now && Object.keys(cachedCerts).length > 0) {
    return cachedCerts;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(GOOGLE_CERTS_URL, { signal: controller.signal });
    if (!res.ok) {
      if (Object.keys(cachedCerts).length > 0) {
        return cachedCerts;
      }
      throw new AuthVerificationError(401, 'Não foi possível validar a sessão. Faça login novamente.');
    }

    const cacheControl = res.headers.get('cache-control') || '';
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
    const maxAgeSec = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
    const certs = (await res.json()) as Record<string, string>;
    cachedCerts = certs;
    certsExpiresAtMs = Date.now() + Math.max(60, maxAgeSec) * 1000;
    return certs;
  } catch (err) {
    if (err instanceof AuthVerificationError) throw err;
    if (Object.keys(cachedCerts).length > 0) {
      return cachedCerts;
    }
    throw new AuthVerificationError(401, 'Tempo esgotado ao validar sessão. Tente novamente.');
  } finally {
    clearTimeout(timer);
  }
}

function base64UrlToBuffer(segment: string): Buffer {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64');
}

async function verifyJwtWithGoogleCerts(token: string, projectId: string): Promise<DecodedIdToken> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AuthVerificationError(401, 'Sessão inválida. Faça login novamente.');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  let header: { alg?: string; kid?: string };
  let payload: DecodedIdToken & { auth_time?: number };
  try {
    header = JSON.parse(base64UrlToBuffer(headerB64).toString('utf-8'));
    payload = JSON.parse(base64UrlToBuffer(payloadB64).toString('utf-8'));
  } catch {
    throw new AuthVerificationError(401, 'Sessão inválida. Faça login novamente.');
  }

  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new AuthVerificationError(401, 'Sessão inválida. Faça login novamente.');
  }

  let certs = await fetchGooglePublicCerts(false);
  let pem = certs[header.kid];
  if (!pem) {
    certs = await fetchGooglePublicCerts(true);
    pem = certs[header.kid];
  }
  if (!pem) {
    throw new AuthVerificationError(401, 'Sessão expirada ou inválida. Faça login novamente.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const signatureOk = verifier.verify(pem, base64UrlToBuffer(signatureB64));
  if (!signatureOk) {
    throw new AuthVerificationError(401, 'Sessão inválida. Faça login novamente.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;

  if (typeof payload.exp !== 'number' || payload.exp <= nowSec - 60) {
    throw new AuthVerificationError(401, 'Sessão expirada. Faça login novamente.');
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) {
    throw new AuthVerificationError(401, 'Sessão inválida. Faça login novamente.');
  }
  if (typeof payload.auth_time !== 'number' || payload.auth_time > nowSec + 300) {
    throw new AuthVerificationError(401, 'Sessão inválida. Faça login novamente.');
  }
  if (payload.aud !== projectId || payload.iss !== expectedIssuer) {
    throw new AuthVerificationError(401, 'Sessão não pertence a este aplicativo.');
  }
  if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0 || payload.sub.length > 128) {
    throw new AuthVerificationError(401, 'Identidade de usuário inválida.');
  }

  return {
    ...payload,
    uid: payload.sub,
  };
}

async function enforceOptionalUserPolicy(
  decoded: DecodedIdToken,
  adminApp: App | null,
  idToken?: string | null,
): Promise<VerifiedFirebaseUser> {
  const allowedEmailsRaw = process.env.ALLOWED_USER_EMAILS?.trim();
  const email = typeof decoded.email === 'string' ? decoded.email.toLowerCase() : null;

  if (allowedEmailsRaw) {
    const allowedSet = new Set(
      allowedEmailsRaw
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    );
    if (!email || !allowedSet.has(email)) {
      throw new AuthVerificationError(403, 'Usuário sem permissão de acesso.');
    }
  }

  const allowedUidsRaw = process.env.ALLOWED_USER_UIDS?.trim();
  if (allowedUidsRaw) {
    const allowedUids = new Set(
      allowedUidsRaw
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    );
    if (!allowedUids.has(decoded.uid)) {
      throw new AuthVerificationError(403, 'Usuário sem permissão de acesso.');
    }
  }

  const tenant = await resolveUserTenant({
    uid: decoded.uid,
    email,
    claimCompanyId: (decoded as Record<string, unknown>).companyId,
    adminApp,
    idToken,
  });

  return {
    uid: decoded.uid,
    email,
    emailVerified: Boolean(decoded.email_verified),
    companyId: tenant.companyId,
  };
}

export function extractBearerToken(authHeader?: string | null): string | null {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const match = authHeader.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1].trim() : null;
}

export async function verifyFirebaseIdTokenHeader(
  authHeader?: string | null,
): Promise<VerifiedFirebaseUser> {
  const token = extractBearerToken(authHeader);
  if (!token) {
    throw new AuthVerificationError(401, 'Autenticação necessária.');
  }

  const projectId = resolveProjectId();
  const adminApp = await getAdminAppIfConfigured();

  if (adminApp) {
    try {
      const { getAuth } = await import('firebase-admin/auth');
      // checkRevoked=true enforces revocation and disabled user validation via Firebase Admin
      const decoded = await getAuth(adminApp).verifyIdToken(token, true);
      return await enforceOptionalUserPolicy(decoded, adminApp, token);
    } catch (err) {
      if (err instanceof AuthVerificationError || err instanceof TenantAccessError) throw err;
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code || '')
          : '';
      if (code === 'auth/user-disabled') {
        throw new AuthVerificationError(403, 'Acesso desativado para esta conta.');
      }
      throw new AuthVerificationError(401, 'Sessão expirada ou inválida. Faça login novamente.');
    }
  }

  const decoded = await verifyJwtWithGoogleCerts(token, projectId);
  return await enforceOptionalUserPolicy(decoded, null, token);
}

export function authErrorResponse(err: unknown): Response {
  const status =
    err instanceof AuthVerificationError || err instanceof TenantAccessError ? err.status : 401;
  const message =
    err instanceof AuthVerificationError || err instanceof TenantAccessError
      ? err.message
      : 'Autenticação necessária.';
  logSecurityEvent(status === 403 ? 'ACCESS_FORBIDDEN' : 'AUTH_REJECTED', { status });
  return Response.json(
    { error: message },
    { status, headers: API_SECURITY_HEADERS },
  );
}
