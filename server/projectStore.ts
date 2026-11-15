import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Project } from '../shared/types.ts';
import type { VerifiedFirebaseUser } from './firebaseAuth.ts';
import {
  assertResourceOwnership,
  getTenantStorageDir,
  isValidResourceId,
  registerResourceOwnership,
  sanitizeIdentifier,
  TenantAccessError,
  unregisterResourceOwnership,
} from './tenantRegistry.ts';
import { getSynchronizedBrasiliaTime } from './timeService.ts';

function getProjectsFile(authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>): string {
  return path.join(getTenantStorageDir(authUser.companyId, authUser.uid), 'projects.json');
}

export function getDefaultProjectIdForUser(uid: string): string {
  return `proj_${sanitizeIdentifier(uid, 'user').slice(0, 64)}`;
}

async function readProjectsRaw(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
): Promise<Project[]> {
  try {
    const raw = await fs.readFile(getProjectsFile(authUser), 'utf-8');
    const parsed = JSON.parse(raw) as Project[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p) =>
        p &&
        typeof p.id === 'string' &&
        p.ownerUid === authUser.uid &&
        p.companyId === authUser.companyId,
    );
  } catch {
    return [];
  }
}

async function writeProjectsRaw(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
  projects: Project[],
): Promise<void> {
  const filePath = getProjectsFile(authUser);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(projects, null, 2), 'utf-8');
}

export async function ensureDefaultProject(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
): Promise<Project> {
  const existing = await readProjectsRaw(authUser);
  if (existing.length > 0) {
    for (const p of existing) {
      await registerResourceOwnership({
        kind: 'projects',
        resourceId: p.id,
        authUser,
      });
    }
    return existing[0];
  }

  const nowIso = (await getSynchronizedBrasiliaTime(false)).isoBrt;
  const defaultProj: Project = {
    id: getDefaultProjectIdForUser(authUser.uid),
    ownerUid: authUser.uid,
    companyId: authUser.companyId,
    name: 'Projeto Principal',
    description: 'Ambiente privado padrão',
    defaultAsset: null,
    defaultTimeframe: null,
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  };

  await registerResourceOwnership({
    kind: 'projects',
    resourceId: defaultProj.id,
    authUser,
  });
  await writeProjectsRaw(authUser, [defaultProj]);
  return defaultProj;
}

export async function listProjects(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
): Promise<Project[]> {
  await ensureDefaultProject(authUser);
  const list = await readProjectsRaw(authUser);
  return list.sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
}

export async function getProjectById(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
  projectId: string,
): Promise<Project> {
  await assertResourceOwnership({
    kind: 'projects',
    resourceId: projectId,
    authUser,
    allowUnregistered: false,
  });
  const list = await listProjects(authUser);
  const found = list.find((p) => p.id === projectId);
  if (!found) {
    throw new TenantAccessError(404, 'Projeto não encontrado.');
  }
  return found;
}

export async function saveProject(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
  input: {
    id?: string;
    name: string;
    description?: string;
    defaultAsset?: string | null;
    defaultTimeframe?: string | null;
  },
): Promise<Project> {
  const cleanName = (input.name || '').trim().slice(0, 100);
  if (!cleanName) {
    throw new TenantAccessError(403, 'Nome do projeto é obrigatório.');
  }

  const id = input.id && input.id.trim()
    ? input.id.trim()
    : `proj_${crypto.randomBytes(6).toString('hex')}`;

  if (!isValidResourceId(id)) {
    throw new TenantAccessError(403, 'Identificador de projeto inválido.');
  }

  await assertResourceOwnership({
    kind: 'projects',
    resourceId: id,
    authUser,
    allowUnregistered: true,
  });

  const existingList = await listProjects(authUser);
  const prev = existingList.find((p) => p.id === id);
  const nowIso = (await getSynchronizedBrasiliaTime(false)).isoBrt;

  const project: Project = {
    id,
    ownerUid: authUser.uid,
    companyId: authUser.companyId,
    name: cleanName,
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 300) : prev?.description,
    defaultAsset: input.defaultAsset !== undefined ? input.defaultAsset : (prev?.defaultAsset ?? null),
    defaultTimeframe:
      input.defaultTimeframe !== undefined ? input.defaultTimeframe : (prev?.defaultTimeframe ?? null),
    createdAtIso: prev?.createdAtIso || nowIso,
    updatedAtIso: nowIso,
  };

  await registerResourceOwnership({
    kind: 'projects',
    resourceId: project.id,
    authUser,
  });

  const updated = prev
    ? existingList.map((p) => (p.id === project.id ? project : p))
    : [...existingList, project];

  await writeProjectsRaw(authUser, updated);
  return project;
}

export async function deleteProject(
  authUser: Pick<VerifiedFirebaseUser, 'uid' | 'companyId'>,
  projectId: string,
): Promise<void> {
  await assertResourceOwnership({
    kind: 'projects',
    resourceId: projectId,
    authUser,
    allowUnregistered: false,
  });

  const list = await listProjects(authUser);
  if (list.length <= 1) {
    throw new Error('Não é possível excluir o único projeto da conta.');
  }

  const remaining = list.filter((p) => p.id !== projectId);
  await writeProjectsRaw(authUser, remaining);
  await unregisterResourceOwnership('projects', projectId, authUser);
}
