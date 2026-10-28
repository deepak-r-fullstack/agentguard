import { FormEvent, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { DisplayButton } from "components/display_components";
import { EFFECT_LABEL, OPERATOR_LABEL } from "utils/helper_functions/format";
import { CatalogAction, ConditionOperator, Decision, PolicyCondition, PolicyInput, RuleField } from "utils/types";

const EFFECTS: Decision[] = ["allow", "require_approval", "deny"];
const NUMBER_OPS: ConditionOperator[] = ["gt", "gte", "lt", "lte", "eq", "neq"];
const TEXT_OPS: ConditionOperator[] = ["eq", "neq", "in", "nin"];
const BOOLEAN_OPS: ConditionOperator[] = ["eq"];

const opsFor = (field?: RuleField) =>
  field?.type === "number" ? NUMBER_OPS : field?.type === "boolean" ? BOOLEAN_OPS : TEXT_OPS;

// Conditions are edited as text so people can type freely; converted to the right type on save.
interface ConditionDraft {
  field: string;
  op: ConditionOperator;
  value: string;
}

function toDraftValue(value: PolicyCondition["value"]) {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function toConditionValue(draft: ConditionDraft, field?: RuleField): PolicyCondition["value"] {
  if (draft.op === "in" || draft.op === "nin") {
    return draft.value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (field?.type === "number") return Number(draft.value);
  if (field?.type === "boolean") return draft.value === "true";
  return draft.value.trim();
}

interface RuleEditorProps {
  catalog: CatalogAction[];
  initial?: Partial<PolicyInput>;
  issues?: string[];
  saving: boolean;
  onSave: (policy: PolicyInput) => void;
  onCancel: () => void;
}

export const RuleEditor = ({ catalog, initial, issues = [], saving, onSave, onCancel }: RuleEditorProps) => {
  const [name, setName] = useState(initial?.name || "");
  const [action, setAction] = useState(initial?.action || catalog[0]?.key || "");
  const [effect, setEffect] = useState<Decision>(initial?.effect || "require_approval");
  const [conditions, setConditions] = useState<ConditionDraft[]>(
    (initial?.conditions || []).map((condition) => ({ ...condition, value: toDraftValue(condition.value) }))
  );
  const [useLimit, setUseLimit] = useState(Boolean(initial?.dailyLimit));
  const [limitScope, setLimitScope] = useState<"agent" | "workspace">(initial?.dailyLimit?.scope || "agent");
  const [limitField, setLimitField] = useState(initial?.dailyLimit?.sumField || "");
  const [limitMax, setLimitMax] = useState(initial?.dailyLimit ? String(initial.dailyLimit.max) : "");
  const [enabled] = useState(initial?.enabled ?? true);
  const [sourceText, setSourceText] = useState(initial?.sourceText || "");
  const [formError, setFormError] = useState("");

  const selectedAction = catalog.find((item) => item.key === action);
  const fields = selectedAction?.ruleFields || [];
  const numberFields = useMemo(() => fields.filter((field) => field.type === "number"), [fields]);

  const updateCondition = (index: number, patch: Partial<ConditionDraft>) =>
    setConditions((current) => current.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)));

  const addCondition = () => {
    const field = fields[0];
    if (!field) return;
    setConditions((current) => [...current, { field: field.path, op: opsFor(field)[0], value: field.type === "boolean" ? "true" : "" }]);
  };

  const onActionChange = (key: string) => {
    setAction(key);
    // Fields differ per action, so start conditions again.
    setConditions([]);
    setLimitField("");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    if (name.trim().length < 3) return setFormError("Give the rule a short name (at least 3 letters).");
    if (conditions.some((condition) => !condition.value.trim())) return setFormError("Fill in every condition, or remove the empty one.");
    if (useLimit && (!limitField || !limitMax || Number(limitMax) < 0)) return setFormError("Choose what to add up and the daily maximum.");

    onSave({
      name: name.trim(),
      action,
      effect,
      enabled,
      sourceText: sourceText.trim(),
      conditions: conditions.map((condition) => ({
        field: condition.field,
        op: condition.op,
        value: toConditionValue(condition, fields.find((field) => field.path === condition.field)),
      })),
      dailyLimit: useLimit ? { scope: limitScope, sumField: limitField, max: Number(limitMax) } : null,
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5 rounded-lg border border-brand/30 bg-sheet p-5 sm:p-6">
      {issues.length > 0 && (
        <div className="rounded-md bg-waiting-tint px-4 py-3 text-sm" role="alert">
          <p className="font-semibold text-waiting">Please check the draft before saving</p>
          <ul className="mt-1 list-disc pl-5">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="rule-name" className="field-label">
            Rule name
          </label>
          <input id="rule-name" className="field-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Big refunds need a manager" />
        </div>
        <div>
          <label htmlFor="rule-action" className="field-label">
            Applies to
          </label>
          <select id="rule-action" className="field-input" value={action} onChange={(event) => onActionChange(event.target.value)}>
            {catalog.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset>
        <legend className="field-label">When the rule applies</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {EFFECTS.map((option) => (
            <label
              key={option}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                effect === option ? "border-brand bg-brand-tint/50" : "border-line"
              }`}
            >
              <input type="radio" name="effect" value={option} checked={effect === option} onChange={() => setEffect(option)} className="accent-brand" />
              {EFFECT_LABEL[option]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="field-label">Only when all of these are true (leave empty for always)</legend>
        <div className="flex flex-col gap-2">
          {conditions.map((condition, index) => {
            const field = fields.find((item) => item.path === condition.field);
            return (
              <div key={index} className="grid gap-2 sm:grid-cols-[1.4fr,1fr,1fr,auto]">
                <select
                  aria-label="Field"
                  className="field-input"
                  value={condition.field}
                  onChange={(event) => {
                    const nextField = fields.find((item) => item.path === event.target.value);
                    updateCondition(index, { field: event.target.value, op: opsFor(nextField)[0], value: nextField?.type === "boolean" ? "true" : "" });
                  }}
                >
                  {fields.map((item) => (
                    <option key={item.path} value={item.path}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <select aria-label="Comparison" className="field-input" value={condition.op} onChange={(event) => updateCondition(index, { op: event.target.value as ConditionOperator })}>
                  {opsFor(field).map((op) => (
                    <option key={op} value={op}>
                      {OPERATOR_LABEL[op]}
                    </option>
                  ))}
                </select>
                {field?.type === "boolean" ? (
                  <select aria-label="Value" className="field-input" value={condition.value} onChange={(event) => updateCondition(index, { value: event.target.value })}>
                    <option value="true">yes</option>
                    <option value="false">no</option>
                  </select>
                ) : (
                  <input
                    aria-label="Value"
                    className="field-input"
                    type={field?.type === "number" && !["in", "nin"].includes(condition.op) ? "number" : "text"}
                    placeholder={["in", "nin"].includes(condition.op) ? "Separate with commas" : "Value"}
                    value={condition.value}
                    onChange={(event) => updateCondition(index, { value: event.target.value })}
                  />
                )}
                <DisplayButton variant="ghost" aria-label="Remove condition" onClick={() => setConditions((current) => current.filter((_, i) => i !== index))}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </DisplayButton>
              </div>
            );
          })}
          <div>
            <DisplayButton variant="ghost" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={addCondition} disabled={!fields.length}>
              Add a condition
            </DisplayButton>
          </div>
        </div>
      </fieldset>

      {numberFields.length > 0 && (
        <fieldset className="rounded-md border border-line p-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={useLimit} onChange={(event) => setUseLimit(event.target.checked)} className="accent-brand" />
            Also limit the daily total (the rule applies only when today's total would go over)
          </label>
          {useLimit && (
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <select aria-label="Add up" className="field-input" value={limitField} onChange={(event) => setLimitField(event.target.value)}>
                <option value="">Add up…</option>
                {numberFields.map((field) => (
                  <option key={field.path} value={field.path}>
                    {field.label}
                  </option>
                ))}
              </select>
              <input aria-label="Daily maximum" type="number" min={0} className="field-input" placeholder="Daily maximum" value={limitMax} onChange={(event) => setLimitMax(event.target.value)} />
              <select aria-label="Counted for" className="field-input" value={limitScope} onChange={(event) => setLimitScope(event.target.value as "agent" | "workspace")}>
                <option value="agent">For each agent</option>
                <option value="workspace">For all agents together</option>
              </select>
            </div>
          )}
        </fieldset>
      )}

      <div>
        <label htmlFor="rule-source" className="field-label">
          The rule in plain words (shown to your team)
        </label>
        <input id="rule-source" className="field-input" value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder="Refunds above ₹10,000 need a manager." />
      </div>

      {formError && (
        <p className="text-sm text-refused" role="alert">
          {formError}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <DisplayButton type="submit" variant="primary" loading={saving}>
          Save rule
        </DisplayButton>
        <DisplayButton variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </DisplayButton>
      </div>
    </form>
  );
};
