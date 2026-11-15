import fs from 'node:fs/promises';
import path from 'node:path';
import type { Conversation } from '../shared/types.ts';
import type { VerifiedFirebaseUser } from './firebaseAuth.ts';
import { ensureAuthorizedProjectForTenant, ensureDefaultProject } from './projectStore.ts';
import {
  assertResourceOwnership,
  getTenantStorageDir,
  isValidResourceId,
  registerResourceOwnership,
  sanitizeIdentifier,
  TenantAccessError,
  unregisterResourceOwnership,
} from './tenantRegistry.ts';

function getTenantConversationsFile(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
): string {
  return path.join(getTenantStorageDir(authUser.companyId, authUser.uid), 'conversations.json');
}

function getLegacyUserConversationsFile(uid: string): string {
  const safeUid = sanitizeIdentifier(uid, 'invalid');
  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join('/tmp/chartpulse-conversations', `${safeUid}.json`);
  }
  return path.resolve(process.cwd(), '.data', 'conversations', `${safeUid}.json`);
}

async function readConversationsRaw(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
): Promise<Conversation[]> {
  const tenantFile = getTenantConversationsFile(authUser);
  try {
    const content = await fs.readFile(tenantFile, 'utf-8');
    const parsed = JSON.parse(content) as Conversation[];
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (c) =>
          c &&
          typeof c.id === 'string' &&
          (!c.ownerUid || c.ownerUid === authUser.uid) &&
          (!c.companyId || c.companyId === authUser.companyId),
      );
    }
  } catch {
    // Check explicit UID-matched legacy file only (never assume ownership of unowned/default files)
    const legacyFile = getLegacyUserConversationsFile(authUser.uid);
    try {
      const legacyRaw = await fs.readFile(legacyFile, 'utf-8');
      const parsed = JSON.parse(legacyRaw) as Conversation[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const defaultProj = await ensureDefaultProject(authUser);
        const migrated = parsed
          .filter((c) => c && typeof c.id === 'string' && isValidResourceId(c.id))
          .map((c) => ({
            ...c,
            ownerUid: authUser.uid,
            companyId: authUser.companyId,
            projectId: c.projectId && isValidResourceId(c.projectId) ? c.projectId : defaultProj.id,
          }));
        await writeConversationsRaw(authUser, migrated);
        return migrated;
      }
    } catch {
      // No legacy conversations for this UID
    }
  }
  return [];
}

async function writeConversationsRaw(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
  list: Conversation[],
): Promise<void> {
  const filePath = getTenantConversationsFile(authUser);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(list), 'utf-8');
}

export async function listConversations(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
  projectId?: string | null,
): Promise<Conversation[]> {
  const defaultProject = await ensureDefaultProject(authUser);
  const resolvedFilterProject = projectId
    ? await ensureAuthorizedProjectForTenant(authUser, projectId)
    : null;

  const raw = await readConversationsRaw(authUser);
  const normalized: Conversation[] = [];
  for (const conv of raw) {
    const resolvedProjId = conv.projectId || defaultProject.id;
    const stamped: Conversation = {
      ...conv,
      ownerUid: authUser.uid,
      companyId: authUser.companyId,
      projectId: resolvedProjId,
    };
    await registerResourceOwnership({
      kind: 'conversations',
      resourceId: stamped.id,
      authUser,
      projectId: resolvedProjId,
    });
    normalized.push(stamped);
  }

  const filtered = resolvedFilterProject
    ? normalized.filter((c) => c.projectId === resolvedFilterProject.id)
    : normalized;

  return filtered.sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso));
}

export async function getConversationById(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
  convId: string,
): Promise<Conversation> {
  const all = await listConversations(authUser);
  await assertResourceOwnership({
    kind: 'conversations',
    resourceId: convId,
    authUser,
    allowUnregistered: false,
  });
  const found = all.find((c) => c.id === convId);
  if (!found) {
    throw new TenantAccessError(404, 'Conversa não encontrada.');
  }
  return found;
}

export async function saveConversation(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
  conv: Conversation,
): Promise<Conversation> {
  if (!conv || !isValidResourceId(conv.id)) {
    throw new TenantAccessError(403, 'Identificador de conversa inválido.');
  }

  await assertResourceOwnership({
    kind: 'conversations',
    resourceId: conv.id,
    authUser,
    allowUnregistered: true,
  });

  const resolvedProject = await ensureAuthorizedProjectForTenant(authUser, conv.projectId);
  const targetProjectId = resolvedProject.id;

  const stamped: Conversation = {
    ...conv,
    ownerUid: authUser.uid,
    companyId: authUser.companyId,
    projectId: targetProjectId,
  };

  await registerResourceOwnership({
    kind: 'conversations',
    resourceId: stamped.id,
    authUser,
    projectId: targetProjectId,
  });

  const existing = await listConversations(authUser);
  const filtered = existing.filter((c) => c.id !== stamped.id);
  const updated = [stamped, ...filtered].slice(0, 50);
  await writeConversationsRaw(authUser, updated);
  return stamped;
}

export async function deleteConversation(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
  convId: string,
): Promise<void> {
  const existing = await listConversations(authUser);
  await assertResourceOwnership({
    kind: 'conversations',
    resourceId: convId,
    authUser,
    allowUnregistered: false,
  });

  const filtered = existing.filter((c) => c.id !== convId);
  await writeConversationsRaw(authUser, filtered);
  await unregisterResourceOwnership('conversations', convId, authUser);
}

export async function deleteConversationsByProject(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
  projectId: string,
): Promise<void> {
  const existing = await listConversations(authUser);
  const toRemove = existing.filter((c) => c.projectId === projectId);
  const remaining = existing.filter((c) => c.projectId !== projectId);
  await writeConversationsRaw(authUser, remaining);
  for (const c of toRemove) {
    await unregisterResourceOwnership('conversations', c.id, authUser);
  }
}
