import { FormEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { DisplayButton, DisplayError } from "components/display_components";
import { authService } from "utils/services/api_services/agentguard_service";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { useAuthStore } from "utils/store/authStore";

const DEMO_PASSWORD = "Demo@1234";

const DEMO_ACCOUNTS = [
  { email: "manager@acme.test", name: "Karan Shah", role: "Manager", does: "Approves, rejects and undoes agent actions" },
  { email: "admin@acme.test", name: "Meera Nair", role: "Admin", does: "Writes the rules agents must follow" },
  { email: "auditor@acme.test", name: "Lakshmi Rao", role: "Auditor", does: "Reads and exports the audit log" },
];

export const LoginScreen = () => {
  const setSession = useAuthStore((state) => state.setSession);
  const navigate = useNavigate();
  // Someone who opened a link while signed out (for example /activity?action=...) lands on that same link after signing in.
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loadingEmail, setLoadingEmail] = useState<string | null>(null);

  const signIn = async (signInEmail: string, signInPassword: string) => {
    setError("");
    setLoadingEmail(signInEmail);
    try {
      const response = await authService.login(signInEmail, signInPassword);
      setSession(response.data.token, response.data.user);
      navigate(`${location.pathname}${location.search}`, { replace: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoadingEmail(null);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    signIn(email, password);
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-2">
          <ShieldCheck className="h-7 w-7 text-brand" aria-hidden />
          <span className="text-xl font-semibold tracking-tight">AgentGuard</span>
        </div>
        <h1 className="font-serif text-3xl">Let AI agents work, with a person in charge.</h1>
        <p className="mt-2 text-ink-soft">
          Every action an agent takes is checked against your rules, approved by a person when it matters, recorded,
          and can be undone.
        </p>

        <section className="mt-8 rounded-lg border border-line bg-sheet p-5">
          <h2 className="text-base font-semibold">Try the demo as</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {DEMO_ACCOUNTS.map((account) => (
              <li key={account.email}>
                <button
                  type="button"
                  onClick={() => signIn(account.email, DEMO_PASSWORD)}
                  disabled={Boolean(loadingEmail)}
                  className="flex w-full items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5 text-left transition-colors hover:border-brand hover:bg-brand-tint/40 disabled:opacity-60"
                >
                  <span>
                    <span className="block font-medium">
                      {account.name}, {account.role}
                    </span>
                    <span className="block text-sm text-ink-soft">{account.does}</span>
                  </span>
                  <span className="text-sm font-semibold text-brand">
                    {loadingEmail === account.email ? "Signing in…" : "Sign in"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3" noValidate>
          <h2 className="text-base font-semibold">Or sign in with email</h2>
          <div>
            <label htmlFor="email" className="field-label">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              className="field-input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="password" className="field-label">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="field-input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          {error && <DisplayError message={error} />}
          <DisplayButton type="submit" variant="primary" size="lg" loading={loadingEmail === email && Boolean(email)} disabled={!email || !password}>
            Sign in
          </DisplayButton>
        </form>
      </div>
    </div>
  );
};
