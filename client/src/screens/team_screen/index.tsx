import { FormEvent, useState } from "react";
import { Copy, Info, UserPlus } from "lucide-react";
import { DisplayButton, DisplayError, DisplayLoading, DisplayPageHeader } from "components/display_components";
import { useAddTeamMember, useChangeTeamRole, useSetTeamMemberActive, useTeam } from "utils/hooks/useAgentGuardQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { showToast } from "utils/store/toastStore";
import { useAuthStore } from "utils/store/authStore";
import { UserRole } from "utils/types";

const ROLES: { value: UserRole; label: string; description: string }[] = [
  { value: "admin", label: "Admin", description: "Looks after everything: people, rules, agent keys and connections. Can also approve and undo." },
  { value: "manager", label: "Manager", description: "Approves or rejects what agents ask for, and can undo what an agent did." },
  { value: "auditor", label: "Auditor", description: "Can look at everything and download the audit log, but cannot approve or change anything." },
];

const roleLabel = (role: UserRole) => ROLES.find((item) => item.value === role)?.label || role;

// Admins add and manage the people in their own company here, so nobody has to touch the database.
export const TeamScreen = () => {
  const me = useAuthStore((state) => state.user);
  const { data, isLoading, error, refetch } = useTeam();
  const addMember = useAddTeamMember();
  const changeRole = useChangeTeamRole();
  const setActive = useSetTeamMemberActive();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("manager");
  // The temporary password is only ever held here, on screen, until the admin has copied it.
  const [added, setAdded] = useState<{ name: string; email: string; password: string } | null>(null);
  const [confirmingOff, setConfirmingOff] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    addMember.mutate(
      { name, email, role },
      {
        onSuccess: (response) => {
          setAdded({ name: response.data.member.name, email: response.data.member.email, password: response.data.temporaryPassword });
          setName("");
          setEmail("");
          setRole("manager");
        },
      }
    );
  };

  const copyPassword = async () => {
    if (!added) return;
    try {
      await navigator.clipboard.writeText(added.password);
      showToast("Password copied.");
    } catch {
      showToast("Could not copy. Select the password and copy it by hand.", "error");
    }
  };

  return (
    <>
      <DisplayPageHeader
        title="Team"
        description="The people who can sign in to AgentGuard for your company. Add someone, change what they are allowed to do, or turn their account off."
      />

      <div className="mb-6 flex gap-3 rounded-lg border border-line bg-sheet px-4 py-3 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
        <p className="text-ink-soft">
          <strong className="text-ink">Using Slack for approvals?</strong> The email in a person's Slack profile must be exactly the same as their email
          here. If they are different, Slack cannot tell who is clicking Approve, and the click will not work.
        </p>
      </div>

      {added && (
        <div className="mb-6 rounded-lg border border-done/40 bg-done-tint p-5" role="status">
          <p className="font-semibold">
            {added.name} has been added. Copy this temporary password now; you will not see it again.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="block flex-1 overflow-x-auto rounded-md bg-sheet px-3 py-2 text-sm">{added.password}</code>
            <DisplayButton icon={<Copy className="h-4 w-4" aria-hidden />} onClick={copyPassword}>
              Copy
            </DisplayButton>
          </div>
          <p className="mt-3 text-sm text-ink-soft">
            Send it to {added.name} privately. They sign in with their email ({added.email}) and this password.
          </p>
          <DisplayButton className="mt-3" onClick={() => setAdded(null)}>
            I have copied it
          </DisplayButton>
        </div>
      )}

      <section className="rounded-lg border border-line bg-sheet p-5">
        <h2 className="text-lg font-semibold">Add a person</h2>
        <form className="mt-3 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
          <div>
            <label htmlFor="team-name" className="field-label">
              Full name
            </label>
            <input
              id="team-name"
              className="field-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Divya Pillai"
              autoComplete="off"
              required
            />
          </div>
          <div>
            <label htmlFor="team-email" className="field-label">
              Email
            </label>
            <input
              id="team-email"
              type="email"
              className="field-input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="divya@yourcompany.com"
              autoComplete="off"
              required
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="team-role" className="field-label">
              What can they do?
            </label>
            <select id="team-role" className="field-input sm:max-w-xs" value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
              {ROLES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-faint">{ROLES.find((item) => item.value === role)?.description}</p>
          </div>
          <div className="sm:col-span-2">
            <DisplayButton type="submit" variant="primary" icon={<UserPlus className="h-4 w-4" aria-hidden />} loading={addMember.isPending}>
              Add person
            </DisplayButton>
            <p className="mt-1 text-xs text-ink-faint">We will make a temporary password for them and show it to you once.</p>
          </div>
        </form>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">People in your company</h2>
        {isLoading && <DisplayLoading label="Loading your team" />}
        {error && <DisplayError message={getErrorMessage(error)} onRetry={() => refetch()} />}

        {data && (
          <ul className="divide-y divide-line rounded-lg border border-line bg-sheet">
            {data.map((person) => {
              const isMe = person.id === me?.id;
              return (
                <li key={person.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold">
                      {person.name}
                      {isMe && <span className="ml-2 text-sm font-normal text-ink-faint">(you)</span>}
                      <span
                        className={`ml-2 inline-flex items-center rounded-full px-2.5 py-0.5 align-middle text-xs font-semibold ${
                          person.active ? "bg-done-tint text-done" : "bg-ink/5 text-ink-soft"
                        }`}
                      >
                        {person.active ? "Active" : "Turned off"}
                      </span>
                    </p>
                    <p className="truncate text-sm text-ink-soft">{person.email}</p>
                    {isMe && <p className="mt-1 text-xs text-ink-faint">You cannot change your own role or turn yourself off. Ask another admin.</p>}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor={`role-${person.id}`}>
                      Role for {person.name}
                    </label>
                    <select
                      id={`role-${person.id}`}
                      className="field-input w-auto"
                      value={person.role}
                      disabled={isMe || changeRole.isPending}
                      onChange={(event) => changeRole.mutate({ id: person.id, role: event.target.value as UserRole })}
                    >
                      {ROLES.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>

                    {person.active ? (
                      confirmingOff === person.id ? (
                        <>
                          <DisplayButton
                            variant="danger"
                            loading={setActive.isPending}
                            onClick={() => setActive.mutate({ id: person.id, active: false }, { onSettled: () => setConfirmingOff(null) })}
                          >
                            Yes, turn off {person.name.split(" ")[0]}
                          </DisplayButton>
                          <DisplayButton variant="ghost" onClick={() => setConfirmingOff(null)}>
                            Cancel
                          </DisplayButton>
                        </>
                      ) : (
                        <DisplayButton variant="danger" disabled={isMe} onClick={() => setConfirmingOff(person.id)}>
                          Turn off account
                        </DisplayButton>
                      )
                    ) : (
                      <DisplayButton loading={setActive.isPending && setActive.variables?.id === person.id} onClick={() => setActive.mutate({ id: person.id, active: true })}>
                        Turn on account
                      </DisplayButton>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 text-xs text-ink-faint">
          Turning an account off signs the person out straight away and stops them signing in. Nothing is deleted, so the audit log still shows their name. You can
          turn the account on again at any time. Your company always keeps at least one active admin.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">What each role can do</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-3">
          {ROLES.map((item) => (
            <div key={item.value} className="rounded-lg border border-line bg-sheet p-4">
              <dt className="font-semibold">{roleLabel(item.value)}</dt>
              <dd className="mt-1 text-sm text-ink-soft">{item.description}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
};
