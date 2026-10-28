import { useState } from "react";
import { Copy, KeyRound } from "lucide-react";
import { DisplayButton, DisplayError, DisplayLoading, DisplayPageHeader } from "components/display_components";
import { useAgents, useRotateAgentKey } from "utils/hooks/useAgentGuardQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { showToast } from "utils/store/toastStore";

// Admins create a key here and paste it into their agent. The full key is shown only once.
export const AgentsScreen = () => {
  const { data, isLoading, error, refetch } = useAgents();
  const rotate = useRotateAgentKey();
  const [newKey, setNewKey] = useState<{ name: string; apiKey: string } | null>(null);

  const copyKey = async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey.apiKey);
      showToast("Key copied.");
    } catch {
      showToast("Could not copy. Select the key and copy it by hand.", "error");
    }
  };

  const curlExample = `curl -X POST http://localhost:5050/api/agent/actions \\
  -H "content-type: application/json" \\
  -H "x-agent-key: ${newKey?.apiKey || "YOUR_AGENT_KEY"}" \\
  -d '{"action":"booking.cancel","params":{"bookingCode":"BK-1003"},
       "reason":"Customer asked in chat","onBehalfOf":"Ravi (support team)",
       "idempotencyKey":"chat-4821-cancel-1"}'`;

  return (
    <>
      <DisplayPageHeader
        title="Agent keys"
        description="Each AI agent signs its requests with its own key. Only a fingerprint of the key is stored, so a new key is shown once and never again."
      />
      {isLoading && <DisplayLoading label="Loading agents" />}
      {error && <DisplayError message={getErrorMessage(error)} onRetry={() => refetch()} />}

      {newKey && (
        <div className="mb-6 rounded-lg border border-done/40 bg-done-tint p-5" role="status">
          <p className="font-semibold">New key for {newKey.name}. Copy it now; you will not see it again.</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="block flex-1 overflow-x-auto rounded-md bg-sheet px-3 py-2 text-sm">{newKey.apiKey}</code>
            <DisplayButton icon={<Copy className="h-4 w-4" aria-hidden />} onClick={copyKey}>
              Copy
            </DisplayButton>
          </div>
        </div>
      )}

      {data && (
        <ul className="divide-y divide-line rounded-lg border border-line bg-sheet">
          {data.map((agent) => (
            <li key={agent.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-semibold">{agent.name}</p>
                <p className="text-sm text-ink-soft">{agent.description}</p>
                <p className="mt-1 text-xs text-ink-faint">Key starts with {agent.apiKeyPreview}</p>
              </div>
              <DisplayButton
                icon={<KeyRound className="h-4 w-4" aria-hidden />}
                loading={rotate.isPending && rotate.variables === agent.id}
                onClick={() =>
                  rotate.mutate(agent.id, {
                    onSuccess: (response) => setNewKey({ name: response.data.name, apiKey: response.data.apiKey }),
                  })
                }
              >
                Create a new key
              </DisplayButton>
            </li>
          ))}
        </ul>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Connect your own agent</h2>
        <p className="mt-1 text-ink-soft">
          Your agent sends each action to AgentGuard instead of calling your systems directly. The old key stops working when you create a new one.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-ink px-4 py-3 text-xs leading-relaxed text-white">{curlExample}</pre>
      </section>
    </>
  );
};
