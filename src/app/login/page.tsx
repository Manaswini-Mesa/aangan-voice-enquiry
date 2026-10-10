import { config } from "@/server/env";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default function LoginPage() {
  const cfg = config();
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-500 text-lg font-semibold text-white">A</div>
          <h1 className="text-xl font-semibold text-stone-900">Aangan Studio</h1>
          <p className="text-sm text-stone-500">Enquiry dashboard — staff only</p>
        </div>
        <div className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
          <LoginForm />
        </div>
        {cfg.mode === "demo" && (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-center text-xs text-amber-900">
            Demo mode — synthetic data only. Demo accounts and the demo password are listed in the README and <code>.env.example</code>.
          </p>
        )}
        {cfg.mode === "live" && cfg.authSecretIsDevFallback && (
          <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-center text-xs text-rose-900">Sign-in disabled: AUTH_SECRET is not configured.</p>
        )}
      </div>
    </main>
  );
}
