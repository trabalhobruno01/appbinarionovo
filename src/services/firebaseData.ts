import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { ref as storageRef, uploadString } from 'firebase/storage';
import type { Conversation, Project } from '../../shared/types.ts';
import { auth, db, storage } from './firebase.ts';

export enum FirestoreOperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: FirestoreOperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: Array<{ providerId?: string | null; email?: string | null }>;
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: FirestoreOperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
  };
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const userPath = `users/${uid}`;
  try {
    await getDocFromServer(doc(db, 'users', uid));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      // Offline mode falls back gracefully to API + user-scoped IndexedDB
      return;
    }
    if (error instanceof Error && error.message.toLowerCase().includes('permission')) {
      handleFirestoreError(error, FirestoreOperationType.GET, userPath);
    }
  }
}

export async function ensureFirestoreTenantDocuments(params: {
  uid: string;
  companyId: string;
  email: string | null;
}): Promise<void> {
  if (!auth.currentUser || auth.currentUser.uid !== params.uid) return;

  const userDocRef = doc(db, 'users', params.uid);
  try {
    const userSnap = await getDoc(userDocRef);
    if (!userSnap.exists()) {
      await setDoc(userDocRef, {
        uid: params.uid,
        companyId: params.companyId,
        ...(params.email ? { email: params.email } : {}),
        role: 'owner',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch {
    // User profile may already be provisioned by Admin SDK or Firestore offline
  }

  const companyDocRef = doc(db, 'companies', params.companyId);
  try {
    const companySnap = await getDoc(companyDocRef);
    if (!companySnap.exists()) {
      await setDoc(companyDocRef, {
        companyId: params.companyId,
        ownerUid: params.uid,
        name: params.email ? `Ambiente ${params.email}` : `Ambiente ${params.uid.slice(0, 8)}`,
        createdAt: serverTimestamp(),
      });
    }
  } catch {
    // Non-fatal fallback
  }
}

export async function syncProjectToFirestore(project: Project): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid || uid !== project.ownerUid) return;

  const path = `companies/${project.companyId}/projects/${project.id}`;
  const docRef = doc(db, 'companies', project.companyId, 'projects', project.id);
  try {
    const existing = await getDoc(docRef);
    if (existing.exists()) {
      await setDoc(
        docRef,
        {
          name: project.name.slice(0, 100),
          ...(project.description ? { description: project.description.slice(0, 300) } : {}),
          ...(project.defaultAsset ? { defaultAsset: project.defaultAsset.slice(0, 40) } : {}),
          ...(project.defaultTimeframe ? { defaultTimeframe: project.defaultTimeframe.slice(0, 16) } : {}),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    } else {
      await setDoc(docRef, {
        id: project.id,
        ownerUid: project.ownerUid,
        companyId: project.companyId,
        name: project.name.slice(0, 100),
        ...(project.description ? { description: project.description.slice(0, 300) } : {}),
        ...(project.defaultAsset ? { defaultAsset: project.defaultAsset.slice(0, 40) } : {}),
        ...(project.defaultTimeframe ? { defaultTimeframe: project.defaultTimeframe.slice(0, 16) } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('permission')) {
      handleFirestoreError(err, FirestoreOperationType.WRITE, path);
    }
  }
}

export async function deleteProjectFromFirestore(
  companyId: string,
  projectId: string,
): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    await deleteDoc(doc(db, 'companies', companyId, 'projects', projectId));
  } catch {
    // Non-fatal
  }
}

export async function syncConversationToFirestore(conv: Conversation): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid || !conv.companyId || !conv.projectId || uid !== conv.ownerUid) return;

  const path = `companies/${conv.companyId}/projects/${conv.projectId}/conversations/${conv.id}`;
  const convRef = doc(
    db,
    'companies',
    conv.companyId,
    'projects',
    conv.projectId,
    'conversations',
    conv.id,
  );
  try {
    const existing = await getDoc(convRef);
    const baseFields = {
      title: (conv.title || 'Nova Análise').slice(0, 160),
      ...(conv.lastAsset ? { lastAsset: conv.lastAsset.slice(0, 64) } : {}),
      ...(conv.lastTimeframe ? { lastTimeframe: conv.lastTimeframe.slice(0, 16) } : {}),
      updatedAtBrt: conv.updatedAtBrt.slice(0, 32),
      messageCount: conv.messages.length,
      updatedAt: serverTimestamp(),
    };

    if (existing.exists()) {
      await setDoc(convRef, baseFields, { merge: true });
    } else {
      await setDoc(convRef, {
        id: conv.id,
        ownerUid: conv.ownerUid,
        companyId: conv.companyId,
        projectId: conv.projectId,
        ...baseFields,
        createdAt: serverTimestamp(),
      });
    }

    // Sync latest messages cleanly without raw base64 blobs
    const latestMsgs = conv.messages.slice(-4);
    for (const msg of latestMsgs) {
      const msgRef = doc(
        db,
        'companies',
        conv.companyId,
        'projects',
        conv.projectId,
        'conversations',
        conv.id,
        'messages',
        msg.id,
      );
      const msgSnap = await getDoc(msgRef);
      if (!msgSnap.exists()) {
        let storagePath: string | undefined;
        if (msg.imageDataUrl) {
          storagePath = `companies/${conv.companyId}/users/${uid}/conversations/${conv.id}/${msg.id}.jpg`;
          void uploadString(
            storageRef(storage, storagePath),
            msg.imageDataUrl,
            'data_url',
            {
              customMetadata: {
                ownerUid: uid,
                companyId: conv.companyId,
                projectId: conv.projectId,
                conversationId: conv.id,
              },
            },
          ).catch(() => {});
        }
        await setDoc(msgRef, {
          id: msg.id,
          ownerUid: conv.ownerUid,
          companyId: conv.companyId,
          projectId: conv.projectId,
          conversationId: conv.id,
          role: msg.role,
          text: msg.text.slice(0, 20000),
          ...(storagePath ? { storagePath } : {}),
          createdAtBrt: msg.createdAtBrt.slice(0, 32),
          createdAt: serverTimestamp(),
        });
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('permission')) {
      handleFirestoreError(err, FirestoreOperationType.WRITE, path);
    }
  }
}

export async function deleteConversationFromFirestore(params: {
  companyId: string;
  projectId: string;
  conversationId: string;
}): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    await deleteDoc(
      doc(
        db,
        'companies',
        params.companyId,
        'projects',
        params.projectId,
        'conversations',
        params.conversationId,
      ),
    );
  } catch {
    // Non-fatal
  }
}

export async function queryOwnedProjectsFromFirestore(
  uid: string,
  companyId: string,
): Promise<Project[]> {
  if (!auth.currentUser || auth.currentUser.uid !== uid) return [];
  const projectsPath = `companies/${companyId}/projects`;
  try {
    const q = query(
      collection(db, 'companies', companyId, 'projects'),
      where('ownerUid', '==', uid),
      where('companyId', '==', companyId),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data() as Partial<Project>;
      return {
        id: d.id,
        ownerUid: uid,
        companyId,
        name: data.name || 'Projeto',
        description: data.description,
        defaultAsset: data.defaultAsset ?? null,
        defaultTimeframe: data.defaultTimeframe ?? null,
        createdAtIso: typeof data.createdAtIso === 'string' ? data.createdAtIso : new Date().toISOString(),
        updatedAtIso: typeof data.updatedAtIso === 'string' ? data.updatedAtIso : new Date().toISOString(),
      };
    });
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('permission')) {
      handleFirestoreError(err, FirestoreOperationType.LIST, projectsPath);
    }
    return [];
  }
}
