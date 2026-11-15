import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { loginWithEmailAndPassword } from '../services/firebase.ts';

interface LoginScreenProps {
  notice?: string | null;
  onClearNotice?: () => void;
}

export function LoginScreen({ notice, onClearNotice }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockedUntilMs, setLockedUntilMs] = useState(0);
  const [lockRemainingSec, setLockRemainingSec] = useState(0);

  useEffect(() => {
    if (!lockedUntilMs) {
      setLockRemainingSec(0);
      return;
    }
    const update = () => {
      const rem = Math.max(0, Math.ceil((lockedUntilMs - Date.now()) / 1000));
      setLockRemainingSec(rem);
      if (rem === 0) {
        setLockedUntilMs(0);
      }
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [lockedUntilMs]);

  const displayedError =
    lockRemainingSec > 0
      ? `Muitas tentativas inválidas. Aguarde ${lockRemainingSec}s antes de tentar novamente.`
      : errorMessage || notice || null;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (lockedUntilMs > Date.now()) {
      return;
    }

    onClearNotice?.();
    setErrorMessage(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setErrorMessage('Preencha os campos obrigatórios.');
      return;
    }

    setIsSubmitting(true);
    try {
      await loginWithEmailAndPassword(trimmedEmail, password);
      setFailedAttempts(0);
      setLockedUntilMs(0);
    } catch (err) {
      const nextFails = failedAttempts + 1;
      setFailedAttempts(nextFails);
      if (nextFails >= 8) {
        setLockedUntilMs(Date.now() + 30_000);
      } else if (nextFails >= 5) {
        setLockedUntilMs(Date.now() + 15_000);
      }
      setErrorMessage(
        err instanceof Error && err.message
          ? err.message
          : 'Não foi possível entrar. Tente novamente.',
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-hidden bg-[#0B0F17] px-4 py-8 text-slate-100">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.08),transparent_55%)]"
      />

      <main className="relative z-10 w-full max-w-sm animate-[fadeIn_180ms_ease-out]">
        <div className="rounded-2xl border border-slate-800/90 bg-[#111722] p-6 shadow-2xl shadow-black/40 sm:p-8">
          <div className="mb-7 text-center">
            <h1 className="font-display text-2xl font-bold tracking-tight text-slate-50">
              ChartPulse AI
            </h1>
          </div>

          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div>
              <label
                htmlFor="login-email"
                className="mb-1.5 block text-xs font-semibold tracking-wider text-slate-300"
              >
                LOGIN
              </label>
              <input
                id="login-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                disabled={isSubmitting}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (errorMessage) setErrorMessage(null);
                  if (notice) onClearNotice?.();
                }}
                placeholder="seu@email.com"
                className="h-12 w-full rounded-xl border border-slate-800 bg-[#0B0F17] px-3.5 text-sm text-slate-100 placeholder:text-slate-600 transition-colors focus:border-emerald-500 focus:outline-none disabled:opacity-60"
              />
            </div>

            <div>
              <label
                htmlFor="login-password"
                className="mb-1.5 block text-xs font-semibold tracking-wider text-slate-300"
              >
                SENHA
              </label>
              <div className="relative">
                <input
                  id="login-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  disabled={isSubmitting}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (errorMessage) setErrorMessage(null);
                    if (notice) onClearNotice?.();
                  }}
                  placeholder="••••••••"
                  className="h-12 w-full rounded-xl border border-slate-800 bg-[#0B0F17] pl-3.5 pr-12 text-sm text-slate-100 placeholder:text-slate-600 transition-colors focus:border-emerald-500 focus:outline-none disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  disabled={isSubmitting}
                  aria-label={showPassword ? 'Ocultar senha' : 'Visualizar senha'}
                  className="absolute right-1 top-1 flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800/70 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {displayedError && (
              <div
                role="alert"
                className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs font-medium text-rose-300"
              >
                {displayedError}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 text-sm font-bold tracking-wide text-slate-950 transition-all hover:bg-emerald-400 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#111722] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>ENTRANDO...</span>
                </>
              ) : (
                <span>ENTRAR</span>
              )}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
