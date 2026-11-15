import type { Conversation, Project } from '../../shared/types.ts';

const DB_NAME = 'chartpulse_db';
const DB_VERSION = 2;
const CONVERSATIONS_STORE = 'conversations';
const PROJECTS_STORE = 'projects';
const CLIENT_TOKEN_KEY = 'chartpulse_client_token';
const THEME_KEY_PREFIX = 'chartpulse_theme';
const ACTIVE_PROJECT_PREFIX = 'chartpulse_active_project';

export function getClientToken(): string {
  let token = sessionStorage.getItem(CLIENT_TOKEN_KEY);
  if (!token) {
    const rand =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '')
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    token = `cp_${rand}`;
    sessionStorage.setItem(CLIENT_TOKEN_KEY, token);
  }
  return token;
}

export function clearSessionCaches(): void {
  try {
    sessionStorage.removeItem(CLIENT_TOKEN_KEY);
    sessionStorage.clear();
    localStorage.removeItem(CLIENT_TOKEN_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function getSavedTheme(uid?: string): 'dark' | 'light' {
  const key = uid ? `${THEME_KEY_PREFIX}:${uid}` : THEME_KEY_PREFIX;
  const saved = localStorage.getItem(key);
  return saved === 'light' ? 'light' : 'dark';
}

export function saveTheme(theme: 'dark' | 'light', uid?: string): void {
  const key = uid ? `${THEME_KEY_PREFIX}:${uid}` : THEME_KEY_PREFIX;
  localStorage.setItem(key, theme);
}

export function getSavedActiveProjectId(uid: string, companyId: string): string | null {
  return localStorage.getItem(`${ACTIVE_PROJECT_PREFIX}:${companyId}:${uid}`);
}

export function saveActiveProjectId(uid: string, companyId: string, projectId: string): void {
  localStorage.setItem(`${ACTIVE_PROJECT_PREFIX}:${companyId}:${uid}`, projectId);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CONVERSATIONS_STORE)) {
        db.createObjectStore(CONVERSATIONS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadLocalProjects(uid: string, companyId: string): Promise<Project[]> {
  if (!uid || !companyId) return [];
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PROJECTS_STORE, 'readonly');
      const store = tx.objectStore(PROJECTS_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const items = ((req.result as Project[]) || []).filter(
          (p) => p && p.ownerUid === uid && p.companyId === companyId,
        );
        items.sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function saveLocalProjects(
  uid: string,
  companyId: string,
  projects: Project[],
): Promise<void> {
  if (!uid || !companyId) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PROJECTS_STORE, 'readwrite');
      const store = tx.objectStore(PROJECTS_STORE);
      for (const proj of projects) {
        if (proj.ownerUid === uid && proj.companyId === companyId) {
          store.put(proj);
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore IndexedDB quota errors
  }
}

export async function deleteLocalProject(
  uid: string,
  companyId: string,
  projectId: string,
): Promise<void> {
  if (!uid || !companyId) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([PROJECTS_STORE, CONVERSATIONS_STORE], 'readwrite');
      const projStore = tx.objectStore(PROJECTS_STORE);
      const getReq = projStore.get(projectId);
      getReq.onsuccess = () => {
        const found = getReq.result as Project | undefined;
        if (found && found.ownerUid === uid && found.companyId === companyId) {
          projStore.delete(projectId);
        }
      };
      const convStore = tx.objectStore(CONVERSATIONS_STORE);
      const allConvReq = convStore.getAll();
      allConvReq.onsuccess = () => {
        const list = (allConvReq.result as Conversation[]) || [];
        for (const c of list) {
          if (c.ownerUid === uid && c.companyId === companyId && c.projectId === projectId) {
            convStore.delete(c.id);
          }
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore
  }
}

export async function loadLocalConversations(
  uid: string,
  companyId: string,
  projectId?: string | null,
): Promise<Conversation[]> {
  if (!uid || !companyId) return [];
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CONVERSATIONS_STORE, 'readonly');
      const store = tx.objectStore(CONVERSATIONS_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        // Strictly reject unowned/legacy or other-tenant records
        const items = ((req.result as Conversation[]) || []).filter(
          (c) =>
            c &&
            c.ownerUid === uid &&
            c.companyId === companyId &&
            (!projectId || c.projectId === projectId),
        );
        items.sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso));
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function saveLocalConversation(
  uid: string,
  companyId: string,
  conv: Conversation,
): Promise<void> {
  if (!uid || !companyId || !conv.projectId) return;
  try {
    const stamped: Conversation = {
      ...conv,
      ownerUid: uid,
      companyId,
    };
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CONVERSATIONS_STORE, 'readwrite');
      const store = tx.objectStore(CONVERSATIONS_STORE);
      const req = store.put(stamped);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Ignore IndexedDB quota errors gracefully
  }
}

export async function deleteLocalConversation(
  uid: string,
  companyId: string,
  id: string,
): Promise<void> {
  if (!uid || !companyId) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CONVERSATIONS_STORE, 'readwrite');
      const store = tx.objectStore(CONVERSATIONS_STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result as Conversation | undefined;
        if (existing && existing.ownerUid === uid && existing.companyId === companyId) {
          store.delete(id);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore
  }
}
