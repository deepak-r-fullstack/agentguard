import { useEffect, useState } from "react";
import { Check, Copy, Send } from "lucide-react";
import { DisplayButton, DisplayError, DisplayLoading, DisplayPageHeader } from "components/display_components";
import { useConnections, useSaveSlackChannel, useSendSlackTest } from "utils/hooks/useAgentGuardQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { showToast } from "utils/store/toastStore";

// Where the app is served is also where agents reach it, unless the API lives on its own address.
const apiBase = (import.meta.env.VITE_API_URL || `${window.location.origin}/api`).replace(/\/$/, "");
const MCP_ADDRESS = `${apiBase}/mcp`;

const copyText = async (text: string, doneMessage: string) => {
  try {
    await navigator.clipboard.writeText(text);
    showToast(doneMessage);
  } catch {
    showToast("Could not copy. Select the text and copy it by hand.", "error");
  }
};

const CodeLine = ({ text, copiedMessage }: { text: string; copiedMessage: string }) => (
  <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start">
    <code className="block flex-1 overflow-x-auto whitespace-pre rounded-md bg-ink px-3 py-2 text-xs leading-relaxed text-white">{text}</code>
    <DisplayButton icon={<Copy className="h-4 w-4" aria-hidden />} onClick={() => copyText(text, copiedMessage)}>
      Copy
    </DisplayButton>
  </div>
);

// Admins connect AI agents (MCP) and choose where approval requests appear (Slack).
export const ConnectionsScreen = () => {
  const { data, isLoading, error, refetch } = useConnections();
  const saveChannel = useSaveSlackChannel();
  const sendTest = useSendSlackTest();
  const [channelId, setChannelId] = useState("");

  useEffect(() => {
    if (data) setChannelId(data.slack.channelId);
  }, [data]);

  const claudeCommand = `claude mcp add --transport http agentguard ${MCP_ADDRESS} \\\n  --header "Authorization: Bearer YOUR_AGENT_KEY"`;
  const channelChanged = data ? channelId.trim().toUpperCase() !== data.slack.channelId : false;

  return (
    <>
      <DisplayPageHeader
        title="Connections"
        description="Connect your AI agents to AgentGuard, and choose where approval requests show up."
      />
      {isLoading && <DisplayLoading label="Loading connections" />}
      {error && <DisplayError message={getErrorMessage(error)} onRetry={() => refetch()} />}

      <section className="rounded-lg border border-line bg-sheet p-5">
        <h2 className="text-lg font-semibold">Connect an AI agent</h2>
        <p className="mt-1 text-ink-soft">
          Many AI tools can connect to AgentGuard using a standard called MCP. Once connected, everything the agent does goes through your rules,
          approvals and Undo, just like the agents you already use.
        </p>

        <h3 className="mt-5 font-semibold">1. Your AgentGuard address</h3>
        <CodeLine text={MCP_ADDRESS} copiedMessage="Address copied." />

        <h3 className="mt-5 font-semibold">2. Get a key for the agent</h3>
        <p className="mt-1 text-ink-soft">
          Open <strong>Agent keys</strong> in the menu and create a key. Copy it right away, because it is only shown once.
        </p>

        <h3 className="mt-5 font-semibold">3. Add AgentGuard to your AI tool</h3>
        <p className="mt-1 text-ink-soft">
          Choose "add an MCP server" in your tool, paste the address, and send the key as a header named <strong>Authorization</strong> with the value{" "}
          <strong>Bearer</strong> followed by a space and your key. For Claude Code, you can paste this one line instead (replace YOUR_AGENT_KEY):
        </p>
        <CodeLine text={claudeCommand} copiedMessage="Command copied." />
      </section>

      {data && (
        <section className="mt-6 rounded-lg border border-line bg-sheet p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Approvals in Slack</h2>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                data.slack.configured ? "bg-done-tint text-done" : "bg-waiting-tint text-waiting"
              }`}
            >
              {data.slack.configured && <Check className="h-3 w-3" aria-hidden />}
              {data.slack.configured ? "Slack is connected" : "Slack is not set up yet"}
            </span>
          </div>
          <p className="mt-1 text-ink-soft">
            When an agent needs a person's OK, AgentGuard posts it in a Slack channel with Approve and Reject buttons. Managers and admins can decide
            right there.
          </p>

          {!data.slack.configured && (
            <p className="mt-3 rounded-md bg-waiting-tint px-3 py-2 text-sm">
              Slack needs a one-time setup by whoever looks after your AgentGuard server. Ask them to follow <strong>docs/slack-setup.md</strong>, then come
              back here.
            </p>
          )}

          <form
            className="mt-4"
            onSubmit={(event) => {
              event.preventDefault();
              saveChannel.mutate(channelId);
            }}
          >
            <label htmlFor="slack-channel" className="field-label">
              Slack channel ID
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="slack-channel"
                className="field-input sm:max-w-xs"
                placeholder="C0123456789"
                value={channelId}
                onChange={(event) => setChannelId(event.target.value)}
                autoComplete="off"
              />
              <DisplayButton type="submit" variant="primary" loading={saveChannel.isPending} disabled={!channelChanged}>
                Save
              </DisplayButton>
            </div>
            <p className="mt-1 text-xs text-ink-faint">
              In Slack, right-click the channel, choose "View channel details", and copy the ID at the bottom. Leave it empty to turn Slack approvals off.
            </p>
          </form>

          <div className="mt-5 border-t border-line pt-4">
            <DisplayButton
              icon={<Send className="h-4 w-4" aria-hidden />}
              loading={sendTest.isPending}
              disabled={!data.slack.configured || !data.slack.channelId || channelChanged}
              onClick={() => sendTest.mutate()}
            >
              Send test message
            </DisplayButton>
            <p className="mt-1 text-xs text-ink-faint">Posts a short hello in your channel, so you know it works. Save the channel first.</p>
          </div>
        </section>
      )}
    </>
  );
};
