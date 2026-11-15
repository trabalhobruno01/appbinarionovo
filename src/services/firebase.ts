import { getApp, getApps, initializeApp, type FirebaseOptions } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  onIdTokenChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import appletConfig from '../../firebase-applet-config.json';

const envConfig: Partial<FirebaseOptions> = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY?.trim() || undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim() || undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim() || undefined,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET?.trim() || undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim() || undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID?.trim() || undefined,
};

const firebaseConfig: FirebaseOptions = {
  apiKey: envConfig.apiKey || appletConfig.apiKey,
  authDomain: envConfig.authDomain || appletConfig.authDomain,
  projectId: envConfig.projectId || appletConfig.projectId,
  storageBucket: envConfig.storageBucket || appletConfig.storageBucket,
  messagingSenderId: envConfig.messagingSenderId || appletConfig.messagingSenderId,
  appId: envConfig.appId || appletConfig.appId,
};

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, appletConfig.firestoreDatabaseId);
export const storage = getStorage(app);

// Keep authenticated session across page reloads on the same browser
void setPersistence(auth, browserLocalPersistence).catch(() => {
  // Browser storage restrictions fall back to Firebase's default memory persistence
});

export function mapAuthErrorMessage(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code || '')
      : '';

  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-email':
      return 'E-mail ou senha incorretos.';
    case 'auth/user-disabled':
      return 'Acesso desativado para esta conta.';
    case 'auth/too-many-requests':
      return 'Muitas tentativas seguidas. Aguarde alguns instantes e tente novamente.';
    case 'auth/network-request-failed':
      return 'Não foi possível conectar. Verifique sua internet e tente novamente.';
    case 'auth/operation-not-allowed':
      return 'Não foi possível entrar. Tente novamente.';
    default:
      return 'Não foi possível entrar. Tente novamente.';
  }
}

export async function loginWithEmailAndPassword(email: string, password: string): Promise<User> {
  const cleanEmail = email.trim();
  if (!cleanEmail || !password) {
    throw new Error('Preencha os campos obrigatórios.');
  }

  try {
    const credential = await signInWithEmailAndPassword(auth, cleanEmail, password);
    return credential.user;
  } catch (err) {
    throw new Error(mapAuthErrorMessage(err));
  }
}

export async function logoutUser(): Promise<void> {
  await signOut(auth);
}

export async function getFreshIdToken(forceRefresh = false): Promise<string | null> {
  const current = auth.currentUser;
  if (!current) return null;
  try {
    return await current.getIdToken(forceRefresh);
  } catch {
    return null;
  }
}

export function subscribeToAuthState(callback: (user: User | null) => void): () => void {
  return onIdTokenChanged(auth, callback);
}
