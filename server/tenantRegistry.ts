import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { App } from 'firebase-admin/app';
import appletConfig from '../firebase-applet-config.json' with { type: 'json' };
import { logSecurityEvent } from './securityGuard.ts';
import { getSynchronizedBrasiliaTime } from './timeService.ts';

export interface TenantUserRecord {
  uid: string;
  companyId: string;
  email: string | null;
  role: 'owner' | 'member';
  provisionedAtIso: string;
}

export interface ResourceOwnerEntry {
  ownerUid: string;
  companyId: string;
  projectId?: string;
}

interface PersistedTenantRegistry {
  users: Record<string, TenantUserRecord>;
  projects: Record<string, ResourceOwnerEntry>;
  conversations: Record<string, ResourceOwnerEntry>;
}

export class TenantAccessError extends Error {
  readonly status: 401 | 403 | 404;

  constructor(status: 401 | 403 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

function getBaseDataDir(): string {
  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return '/tmp/chartpulse-tenants';
  }
  return path.resolve(process.cwd(), '.data', 'tenants');
}

function getRegistryPath(): string {
  return path.join(getBaseDataDir(), '_registry.json');
}

export function sanitizeIdentifier(raw: string, fallback = 'invalid'): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
  return cleaned || fallback;
}

export function isValidResourceId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

export function deriveImmutableCompanyId(uid: string): string {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(uid)) {
    return `cmp_${uid}`;
  }
  const digest = crypto.createHash('sha256').update(`chartpulse:${uid}`).digest('hex').slice(0, 24);
  return `cmp_${digest}`;
}

export function getTenantStorageDir(companyId: string, uid: string): string {
  const safeCompany = sanitizeIdentifier(companyId, 'cmp_invalid');
  const safeUid = sanitizeIdentifier(uid, 'uid_invalid');
  return path.join(getBaseDataDir(), `${safeCompany}__${safeUid}`);
}

export function getTenantScopeKey(companyId: string, uid: string): string {
  return `${sanitizeIdentifier(companyId)}__${sanitizeIdentifier(uid)}`;
}

let registryLoaded = false;
let registryState: PersistedTenantRegistry = {
  users: {},
  projects: {},
  conversations: {},
};

async function ensureRegistryLoaded(): Promise<void> {
  if (registryLoaded) return;
  registryLoaded = true;
  try {
    const raw = await fs.readFile(getRegistryPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedTenantRegistry>;
    registryState = {
      users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
      projects: parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {},
      conversations:
        parsed.conversations && typeof parsed.conversations === 'object'
          ? parsed.conversations
          : {},
    };
  } catch {
    registryState = { users: {}, projects: {}, conversations: {} };
  }
}

async function persistRegistry(): Promise<void> {
  const filePath = getRegistryPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(registryState, null, 2), 'utf-8');
}

async function syncTenantToFirestoreAdmin(
  adminApp: App | null,
  record: TenantUserRecord,
): Promise<TenantUserRecord> {
  if (!adminApp) return record;
  try {
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    const db = getFirestore(adminApp, appletConfig.firestoreDatabaseId);
    const userRef = db.collection('users').doc(record.uid);
    const snap = await userRef.get();
    if (snap.exists) {
      const data = snap.data() as { companyId?: string; email?: string; role?: 'owner' | 'member' };
      if (data?.companyId && isValidResourceId(data.companyId)) {
        return {
          ...record,
          companyId: data.companyId,
          email: data.email || record.email,
          role: data.role || record.role,
        };
      }
    }

    await userRef.set({
      uid: record.uid,
      companyId: record.companyId,
      email: record.email || '',
      role: record.role,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const companyRef = db.collection('companies').doc(record.companyId);
    const compSnap = await companyRef.get();
    if (!compSnap.exists) {
      await companyRef.set({
        companyId: record.companyId,
        ownerUid: record.uid,
        name: record.email ? `Ambiente ${record.email}` : `Ambiente ${record.uid.slice(0, 8)}`,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  } catch {
    // Non-fatal if Firestore Enterprise DB is disabled or offline in test environments
  }
  return record;
}

export async function resolveUserTenant(params: {
  uid: string;
  email: string | null;
  claimCompanyId?: unknown;
  adminApp?: App | null;
}): Promise<TenantUserRecord> {
  await ensureRegistryLoaded();

  const existing = registryState.users[params.uid];
  if (existing && isValidResourceId(existing.companyId)) {
    return existing;
  }

  const claimCompany =
    typeof params.claimCompanyId === 'string' && isValidResourceId(params.claimCompanyId)
      ? params.claimCompanyId
      : null;

  const nowIso = (await getSynchronizedBrasiliaTime(false)).isoBrt;
  let record: TenantUserRecord = {
    uid: params.uid,
    companyId: claimCompany || deriveImmutableCompanyId(params.uid),
    email: params.email,
    role: 'owner',
    provisionedAtIso: nowIso,
  };

  record = await syncTenantToFirestoreAdmin(params.adminApp || null, record);
  registryState.users[params.uid] = record;
  await persistRegistry();
  return record;
}

export async function adminProvisionUserTenant(params: {
  uid: string;
  companyId: string;
  email: string | null;
  role?: 'owner' | 'member';
  adminApp?: App | null;
}): Promise<TenantUserRecord> {
  if (!isValidResourceId(params.uid) || !isValidResourceId(params.companyId)) {
    throw new Error('UID ou companyId inválido para provisionamento administrativo.');
  }
  await ensureRegistryLoaded();
  const nowIso = (await getSynchronizedBrasiliaTime(false)).isoBrt;
  const record: TenantUserRecord = {
    uid: params.uid,
    companyId: params.companyId,
    email: params.email,
    role: params.role || 'owner',
    provisionedAtIso: nowIso,
  };
  await syncTenantToFirestoreAdmin(params.adminApp || null, record);
  registryState.users[params.uid] = record;
  await persistRegistry();
  return record;
}

export function assertNoTenantSpoofing(
  authUser: { uid: string; companyId: string },
  untrustedInputs: Array<string | null | undefined>,
  fieldType: 'uid' | 'companyId',
): void {
  for (const raw of untrustedInputs) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const candidate = raw.trim();
    const expected = fieldType === 'uid' ? authUser.uid : authUser.companyId;
    if (candidate !== expected) {
      logSecurityEvent('BLOCKED_TENANT_SPOOFING', {
        fieldType,
        uidPrefix: authUser.uid.slice(0, 8),
      });
      throw new TenantAccessError(
        403,
        'Acesso negado: tentativa de acesso cruzado ou manipulação de identidade entre contas.',
      );
    }
  }
}

export async function getResourceOwner(
  kind: 'projects' | 'conversations',
  resourceId: string,
): Promise<ResourceOwnerEntry | null> {
  await ensureRegistryLoaded();
  return registryState[kind][resourceId] || null;
}

export async function assertResourceOwnership(params: {
  kind: 'projects' | 'conversations';
  resourceId: string;
  authUser: { uid: string; companyId: string };
  allowUnregistered?: boolean;
}): Promise<ResourceOwnerEntry | null> {
  if (!isValidResourceId(params.resourceId)) {
    throw new TenantAccessError(403, 'Identificador de recurso inválido.');
  }
  await ensureRegistryLoaded();
  const entry = registryState[params.kind][params.resourceId];
  if (!entry) {
    if (params.allowUnregistered) return null;
    throw new TenantAccessError(404, 'Recurso não encontrado neste ambiente.');
  }
  if (
    entry.ownerUid !== params.authUser.uid ||
    entry.companyId !== params.authUser.companyId
  ) {
    logSecurityEvent('BLOCKED_CROSS_TENANT_RESOURCE', {
      kind: params.kind,
      uidPrefix: params.authUser.uid.slice(0, 8),
    });
    throw new TenantAccessError(
      403,
      'Acesso negado: este recurso pertence exclusivamente a outra conta ou empresa.',
    );
  }
  return entry;
}

export async function registerResourceOwnership(params: {
  kind: 'projects' | 'conversations';
  resourceId: string;
  authUser: { uid: string; companyId: string };
  projectId?: string;
}): Promise<void> {
  if (!isValidResourceId(params.resourceId)) {
    throw new TenantAccessError(403, 'Identificador de recurso inválido.');
  }
  await ensureRegistryLoaded();
  const existing = registryState[params.kind][params.resourceId];
  if (
    existing &&
    (existing.ownerUid !== params.authUser.uid || existing.companyId !== params.authUser.companyId)
  ) {
    throw new TenantAccessError(
      403,
      'Acesso negado: este identificador já pertence a outra conta ou empresa.',
    );
  }

  registryState[params.kind][params.resourceId] = {
    ownerUid: params.authUser.uid,
    companyId: params.authUser.companyId,
    ...(params.projectId ? { projectId: params.projectId } : {}),
  };
  await persistRegistry();
}

export async function unregisterResourceOwnership(
  kind: 'projects' | 'conversations',
  resourceId: string,
  authUser: { uid: string; companyId: string },
): Promise<void> {
  await ensureRegistryLoaded();
  const existing = registryState[kind][resourceId];
  if (
    existing &&
    (existing.ownerUid !== authUser.uid || existing.companyId !== authUser.companyId)
  ) {
    throw new TenantAccessError(
      403,
      'Acesso negado: você não tem permissão para remover este recurso.',
    );
  }
  if (existing) {
    delete registryState[kind][resourceId];
    await persistRegistry();
  }
}
