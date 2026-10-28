import { FormEvent, useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import {
  DisplayButton,
  DisplayEmptyState,
  DisplayError,
  DisplayLoading,
  DisplayPageHeader,
} from "components/display_components";
import { useCatalog, useDeletePolicy, useDraftPolicy, usePolicies, useSavePolicy } from "utils/hooks/useAgentGuardQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { describeCondition, describeDailyLimit, EFFECT_LABEL } from "utils/helper_functions/format";
import { useAuthStore } from "utils/store/authStore";
import { CatalogAction, Decision, Policy, PolicyInput } from "utils/types";
import { RuleEditor } from "./RuleEditor";

const EFFECT_STYLE: Record<Decision, string> = {
  allow: "bg-done-tint text-done",
  require_approval: "bg-waiting-tint text-waiting",
  deny: "bg-refused-tint text-refused",
};

type EditorState = { mode: "closed" } | { mode: "new"; initial?: Partial<PolicyInput>; issues?: string[] } | { mode: "edit"; policy: Policy };

const RuleRow = ({
  policy,
  catalog,
  isAdmin,
  onEdit,
}: {
  policy: Policy;
  catalog: CatalogAction[];
  isAdmin: boolean;
  onEdit: () => void;
}) => {
  const save = useSavePolicy();
  const remove = useDeletePolicy();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fields = catalog.find((item) => item.key === policy.action)?.ruleFields || [];
  const conditionsText = policy.conditions.map((condition) => describeCondition(condition, fields));
  if (policy.dailyLimit) conditionsText.push(describeDailyLimit(policy.dailyLimit, fields));

  const toggle = () => {
    const { id: _id, createdAt: _createdAt, ...input } = policy;
    save.mutate({ id: policy.id, policy: { ...input, enabled: !policy.enabled } });
  };

  return (
    <li className={`px-5 py-4 ${policy.enabled ? "" : "opacity-60"}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{policy.name}</h3>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${EFFECT_STYLE[policy.effect]}`}>{EFFECT_LABEL[policy.effect]}</span>
            {!policy.enabled && <span className="text-xs text-ink-faint">Turned off</span>}
          </div>
          {policy.sourceText && <p className="mt-1 font-serif text-ink-soft">“{policy.sourceText}”</p>}
          <p className="mt-1 text-sm text-ink-soft">
            {conditionsText.length ? `When: ${conditionsText.join(", and ")}.` : "Always."}
          </p>
        </div>
        {isAdmin && (
          <div className="flex shrink-0 flex-wrap gap-1">
            <DisplayButton variant="ghost" onClick={toggle} loading={save.isPending}>
              {policy.enabled ? "Turn off" : "Turn on"}
            </DisplayButton>
            <DisplayButton variant="ghost" onClick={onEdit}>
              Edit
            </DisplayButton>
            {confirmDelete ? (
              <DisplayButton variant="danger" loading={remove.isPending} onClick={() => remove.mutate(policy.id)}>
                Delete for good
              </DisplayButton>
            ) : (
              <DisplayButton variant="ghost" onClick={() => setConfirmDelete(true)}>
                Delete
              </DisplayButton>
            )}
          </div>
        )}
      </div>
    </li>
  );
};

export const RulesScreen = () => {
  const user = useAuthStore((state) => state.user);
  const isAdmin = user?.role === "admin";
  const { data: policies, isLoading, error, refetch } = usePolicies();
  const { data: catalog } = useCatalog();
  const save = useSavePolicy();
  const draft = useDraftPolicy();
  const [editor, setEditor] = useState<EditorState>({ mode: "closed" });
  const [sentence, setSentence] = useState("");
  const [draftNote, setDraftNote] = useState("");

  const aiReady = Boolean(catalog?.ai.configured);
  const actions = catalog?.actions || [];

  const requestDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (sentence.trim().length < 5) return;
    try {
      const response = await draft.mutateAsync(sentence.trim());
      setDraftNote(response.data.explanation);
      setEditor({ mode: "new", initial: response.data.draft, issues: response.data.issues });
    } catch {
      // The hook already showed a message; keep the sentence so the person can retry.
    }
  };

  const onSave = (policy: PolicyInput) => {
    const id = editor.mode === "edit" ? editor.policy.id : undefined;
    save.mutate(
      { id, policy },
      {
        onSuccess: () => {
          setEditor({ mode: "closed" });
          setSentence("");
          setDraftNote("");
        },
      }
    );
  };

  // Group rules under the action they control.
  const groups = actions
    .map((action) => ({ action, rules: (policies || []).filter((policy) => policy.action === action.key) }))
    .filter((group) => group.rules.length > 0);
  const wildcardRules = (policies || []).filter((policy) => policy.action === "*");

  return (
    <>
      <DisplayPageHeader
        title="Rules"
        description="Rules decide what an agent may do alone, what needs a person, and what is never allowed. If no rule covers an action, a person must approve it."
        actions={
          isAdmin &&
          editor.mode === "closed" && (
            <DisplayButton variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setEditor({ mode: "new" })}>
              Build a rule
            </DisplayButton>
          )
        }
      />

      {isAdmin && editor.mode === "closed" && (
        <form onSubmit={requestDraft} className="mb-8 rounded-lg border border-line bg-sheet p-5">
          <label htmlFor="rule-sentence" className="text-base font-semibold">
            Write a rule in your own words
          </label>
          <p className="mt-1 text-sm text-ink-soft">
            {aiReady
              ? "AI turns your sentence into a rule. You check it before it is saved, and AI never makes the final decision on an action."
              : "AI drafting is off on this server (set LLM_PROVIDER to turn it on). You can still build any rule with the form."}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              id="rule-sentence"
              className="field-input"
              placeholder="For example: discounts over 15% need a manager"
              value={sentence}
              onChange={(event) => setSentence(event.target.value)}
              disabled={!aiReady}
              maxLength={500}
            />
            <DisplayButton
              type="submit"
              variant="primary"
              icon={<Sparkles className="h-4 w-4" aria-hidden />}
              loading={draft.isPending}
              disabled={!aiReady || sentence.trim().length < 5}
              className="shrink-0"
            >
              Draft the rule
            </DisplayButton>
          </div>
        </form>
      )}

      {editor.mode !== "closed" && actions.length > 0 && (
        <div className="mb-8">
          {draftNote && <p className="mb-3 font-serif text-lg">AI's reading: {draftNote}</p>}
          <RuleEditor
            key={editor.mode === "edit" ? editor.policy.id : JSON.stringify(editor.initial || {})}
            catalog={actions}
            initial={editor.mode === "edit" ? editor.policy : editor.initial}
            issues={editor.mode === "new" ? editor.issues : []}
            saving={save.isPending}
            onSave={onSave}
            onCancel={() => {
              setEditor({ mode: "closed" });
              setDraftNote("");
            }}
          />
        </div>
      )}

      {isLoading && <DisplayLoading label="Loading rules" />}
      {error && <DisplayError message={getErrorMessage(error)} onRetry={() => refetch()} />}
      {policies && policies.length === 0 && (
        <DisplayEmptyState title="No rules yet." description="Without rules, every agent action waits for a person. Add a rule to let safe actions run on their own." />
      )}

      <div className="flex flex-col gap-6">
        {wildcardRules.length > 0 && (
          <section>
            <h2 className="mb-2 text-lg font-semibold">Every action</h2>
            <ul className="divide-y divide-line rounded-lg border border-line bg-sheet">
              {wildcardRules.map((policy) => (
                <RuleRow key={policy.id} policy={policy} catalog={actions} isAdmin={isAdmin} onEdit={() => setEditor({ mode: "edit", policy })} />
              ))}
            </ul>
          </section>
        )}
        {groups.map(({ action, rules }) => (
          <section key={action.key}>
            <h2 className="text-lg font-semibold">{action.label}</h2>
            <p className="mb-2 text-sm text-ink-soft">
              {action.description}
              {action.irreversible ? " Because it cannot be undone, a person always approves it." : ""}
            </p>
            <ul className="divide-y divide-line rounded-lg border border-line bg-sheet">
              {rules.map((policy) => (
                <RuleRow key={policy.id} policy={policy} catalog={actions} isAdmin={isAdmin} onEdit={() => setEditor({ mode: "edit", policy })} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
};
