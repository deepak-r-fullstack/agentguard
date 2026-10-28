import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  actionService,
  agentService,
  auditService,
  demoService,
  integrationService,
  policyService,
  settingsService,
  teamService,
} from "utils/services/api_services/agentguard_service";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { showToast } from "utils/store/toastStore";
import { PolicyInput, UserRole } from "utils/types";

// React Query hooks, one per screen need. Mutations refresh every list an action
// can change, so screens never show stale state after Approve or Undo.

export const queryKeys = {
  actions: (filters: object) => ["actions", filters] as const,
  action: (id: string) => ["action", id] as const,
  stats: ["actions-stats"] as const,
  policies: ["policies"] as const,
  catalog: ["catalog"] as const,
  audit: (filters: object) => ["audit", filters] as const,
  company: ["company"] as const,
  agents: ["agents"] as const,
  connections: ["connections"] as const,
  approvalSettings: ["settings", "approvals"] as const,
  team: ["team"] as const,
};

// Approvals arrive from agents at any time, so these lists refresh themselves.
const LIVE_REFRESH_MS = 5000;

export function useActions(filters: { status?: string; action?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.actions(filters),
    queryFn: () => actionService.list(filters).then((response) => response.data),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useActionDetail(id: string | null) {
  return useQuery({
    queryKey: queryKeys.action(id || ""),
    queryFn: () => actionService.get(id as string).then((response) => response.data),
    enabled: Boolean(id),
  });
}

export function useActionStats() {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: () => actionService.stats().then((response) => response.data),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function usePolicies() {
  return useQuery({ queryKey: queryKeys.policies, queryFn: () => policyService.list().then((response) => response.data) });
}

export function useCatalog() {
  return useQuery({
    queryKey: queryKeys.catalog,
    queryFn: () => policyService.catalog().then((response) => response.data),
    staleTime: 5 * 60 * 1000,
  });
}

export function useAuditEvents(filters: { type?: string; actorType?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.audit(filters),
    queryFn: () => auditService.list(filters).then((response) => response.data),
  });
}

// Shares the "audit" key prefix, so every refresh of the audit log also re-checks the history.
export function useAuditVerification() {
  return useQuery({
    queryKey: ["audit", "verify"] as const,
    queryFn: () => auditService.verify().then((response) => response.data),
  });
}

export function useApprovalSettings() {
  return useQuery({
    queryKey: queryKeys.approvalSettings,
    queryFn: () => settingsService.getApprovals().then((response) => response.data),
  });
}

export function useCompanyData() {
  return useQuery({
    queryKey: queryKeys.company,
    queryFn: () => demoService.company().then((response) => response.data),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useAgents() {
  return useQuery({ queryKey: queryKeys.agents, queryFn: () => agentService.list().then((response) => response.data) });
}

export function useTeam() {
  return useQuery({ queryKey: queryKeys.team, queryFn: () => teamService.list().then((response) => response.data) });
}

export function useConnections() {
  return useQuery({ queryKey: queryKeys.connections, queryFn: () => integrationService.get().then((response) => response.data) });
}

// ---------- mutations ----------

function useRefreshEverything() {
  const queryClient = useQueryClient();
  return () => {
    ["actions", "action", "actions-stats", "audit", "company", "policies"].forEach((key) =>
      queryClient.invalidateQueries({ queryKey: [key] })
    );
  };
}

type ActionVerb = "approve" | "reject" | "undo";

export function useActionDecision(verb: ActionVerb) {
  const refresh = useRefreshEverything();
  return useMutation({
    mutationFn: (input: { id: string; note?: string }) => {
      if (verb === "approve") return actionService.approve(input.id);
      if (verb === "reject") return actionService.reject(input.id, input.note);
      return actionService.undo(input.id);
    },
    onSuccess: (response) => {
      const failed = response.data.status === "failed";
      showToast(failed ? `Approved, but it failed: ${response.data.errorMessage}` : response.message, failed ? "error" : "success");
      refresh();
    },
    onError: (error) => {
      showToast(getErrorMessage(error), "error");
      refresh();
    },
  });
}

export function useSavePolicy() {
  const refresh = useRefreshEverything();
  return useMutation({
    mutationFn: (input: { id?: string; policy: PolicyInput }) =>
      input.id ? policyService.update(input.id, input.policy) : policyService.create(input.policy),
    onSuccess: (response) => {
      showToast(response.message);
      refresh();
    },
    onError: (error) => showToast(getErrorMessage(error), "error"),
  });
}

export function useDeletePolicy() {
  const refresh = useRefreshEverything();
  return useMutation({
    mutationFn: (id: string) => policyService.remove(id),
    onSuccess: (response) => {
      showToast(response.message);
      refresh();
    },
    onError: (error) => showToast(getErrorMessage(error), "error"),
  });
}

export function useDraftPolicy() {
  return useMutation({
    mutationFn: (text: string) => policyService.draft(text),
    onError: (error) => showToast(getErrorMessage(error), "error"),
  });
}

export function usePlaygroundAct() {
  const refresh = useRefreshEverything();
  return useMutation({
    mutationFn: demoService.act,
    onSettled: () => refresh(),
  });
}

export function usePlaygroundChat() {
  const refresh = useRefreshEverything();
  return useMutation({
    mutationFn: (input: { instruction: string; onBehalfOf: string }) => demoService.chat(input.instruction, input.onBehalfOf),
    onError: (error) => showToast(getErrorMessage(error), "error"),
    onSettled: () => refresh(),
  });
}

export function useResetDemo() {
  const refresh = useRefreshEverything();
  return useMutation({
    mutationFn: demoService.reset,
    onSuccess: (response) => {
      showToast(response.message);
      refresh();
    },
    onError: (error) => showToast(getErrorMessage(error), "error"),
  });
}

export function useRotateAgentKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => agentService.rotateKey(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.agents }),
    onError: (error) => showToast(getErrorMessage(error), "error"),
  });
}

// Every team change is also an Audit log entry, so both lists are refreshed.
function useRefreshTeam() {
  const queryClient = useQueryClient();
  return () => {
    ["team", "audit"].forEach((key) => queryClient.invalidateQueries({ queryKey: [key] }));
  };
}

export function useAddTeamMember() {
  const refresh = useRefreshTeam();
  return useMutation({
    mutationFn: teamService.add,
    onSuccess: refresh,
    onError: (error) => showToast(getErrorMessage(error), "error"),
  });
}

export function useChangeTeamRole() {
  const refresh = useRefreshTeam();
  return useMutation({
    mutationFn: (input: { id: string; role: UserRole }) => teamService.changeRole(input.id, input.role),
    onSuccess: (response) => {
      showToast(response.message);
      refresh();
    },
    onError: (error) => {
      showToast(getErrorMessage(error), "error");
      refresh();
    },
  });
}

export function useSetTeamMemberActive() {
  const refresh = useRefreshTeam();
  return useMutation({
    mutationFn: (input: { id: string; active: boolean }) => (input.active ? teamService.reactivate(input.id) : teamService.deactivate(input.id)),
    onSuccess: (response) => {
      showToast(response.message);
      refresh();
    },
    onError: (error) => {
      showToast(getErrorMessage(error), "error");
      refresh();
    },
  });
}

export function useSaveApprovalSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (approvalExpiryHours: number) => settingsService.saveApprovals(approvalExpiryHours),
    onSuccess: (response) => {
      showToast(response.message);
      ["settings", "audit"].forEach((key) => queryClient.invalidateQueries({ queryKey: [key] }));
    },
    onError: (error) => showToast(getErrorMessage(error), "error"),
  });
}

export function useSaveSlackChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slackChannelId: string) => integrationService.saveSlackChannel(slackChannelId),
    onSuccess: (response) => {
      showToast(response.message);
      queryClient.invalidateQueries({ queryKey: queryKeys.connections });
    },
    onError: (error) => showToast(getErrorMessage(error), "error"),
  });
}

export function useSendSlackTest() {
  return useMutation({
    mutationFn: integrationService.sendSlackTest,
    onSuccess: (response) => showToast(response.message),
    onError: (error) => showToast(getErrorMessage(error), "error"),
  });
}
