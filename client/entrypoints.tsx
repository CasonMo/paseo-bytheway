import {
  useRpc,
  type PluginWorkspaceRowBadgeItemProps,
} from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { threadsSummary } from "../shared/contracts";
import { useT } from "./i18n";

export function SidekickWorkspaceBadge({ workspaceId }: PluginWorkspaceRowBadgeItemProps) {
  const t = useT();
  const summary = useRpc(threadsSummary);
  const { data } = useQuery({
    queryKey: ["bytheway", "workspace-summary"],
    queryFn: () => summary({}),
    refetchInterval: 5000,
  });
  const entry = data?.workspaces?.[workspaceId];
  if (!entry || entry.total === 0) return null;
  return (
    <WorkspaceRowBadge
      icon="MessagesSquare"
      label={t.sideChatBadge(entry.total)}
      tone={entry.attention > 0 ? "warning" : entry.running > 0 ? "info" : "muted"}
    />
  );
}
