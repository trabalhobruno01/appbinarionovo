import { cert, getApps, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { adminProvisionUserTenant } from './tenantRegistry.ts';

function loadServiceAccountFromEnv(): ServiceAccount | null {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawJson) {
    const parsed = JSON.parse(rawJson) as {
      project_id?: string;
      projectId?: string;
      client_email?: string;
      clientEmail?: string;
      private_key?: string;
      privateKey?: string;
    };
    const projectId = parsed.project_id || parsed.projectId;
    const clientEmail = parsed.client_email || parsed.clientEmail;
    const privateKey = (parsed.private_key || parsed.privateKey)?.replace(/\\n/g, '\n');
    if (projectId && clientEmail && privateKey) {
      return { projectId, clientEmail, privateKey };
    }
  }

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey };
  }
  return null;
}

/**
 * Administrative provisioning helper: creates/looks up a Firebase Auth user,
 * assigns an immutable custom claim companyId, and writes the tenant profile.
 */
export async function provisionAuthorizedCompanyUser(params: {
  email: string;
  password?: string;
  companyId: string;
  role?: 'owner' | 'member';
}): Promise<{ uid: string; email: string; companyId: string }> {
  const sa = loadServiceAccountFromEnv();
  if (!sa) {
    throw new Error(
      'Credenciais administrativas Firebase (FIREBASE_SERVICE_ACCOUNT_JSON ou FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY) não configuradas.',
    );
  }

  const app =
    getApps().find((a) => a.name === 'chartpulse-provision') ||
    initializeApp({ credential: cert(sa), projectId: sa.projectId }, 'chartpulse-provision');

  const auth = getAuth(app);
  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(params.email.trim());
  } catch {
    if (!params.password || params.password.length < 6) {
      throw new Error('Senha com mínimo de 6 caracteres é obrigatória para criar novo usuário.');
    }
    userRecord = await auth.createUser({
      email: params.email.trim(),
      password: params.password,
      emailVerified: true,
    });
  }

  await auth.setCustomUserClaims(userRecord.uid, {
    companyId: params.companyId,
    role: params.role || 'owner',
  });

  await adminProvisionUserTenant({
    uid: userRecord.uid,
    companyId: params.companyId,
    email: userRecord.email || params.email.trim(),
    role: params.role || 'owner',
    adminApp: app,
  });

  return {
    uid: userRecord.uid,
    email: userRecord.email || params.email.trim(),
    companyId: params.companyId,
  };
}
