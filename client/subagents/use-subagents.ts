import { usePaseo } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveItem } from "../live/types";
import {
  countFinishedSubagents,
  isFinishedSubagent,
  mergeSubagentRows,
  PARENT_AGENT_ID_LABEL,
  providerRowsFromTimeline,
  summarizeSubagents,
  type PaseoSubagentAgentLike,
  type ProviderSubagentDescriptorLike,
  type SubagentRow,
  type SubagentSummary,
} from "./model";

type ProviderSubagentUpdate =
  | { kind: "upsert"; subagent: ProviderSubagentDescriptorLike }
  | { kind: "timeline"; parentAgentId: string; subagentId: string }
  | { kind: "remove"; parentAgentId: string; subagentId: string };

export interface SubagentActions {
  rows: SubagentRow[];
  summary: SubagentSummary;
  finishedCount: number;
  archivePaseoSubagent: (agentId: string) => Promise<void>;
  detachPaseoSubagent: (agentId: string) => Promise<void>;
  archiveFinished: () => Promise<{ archived: number; dismissed: number }>;
}

const PASEO_REFRESH_INTERVAL_MS = 2_500;

export function useSidekickSubagents(
  parentAgentId: string | null,
  items: LiveItem[],
  fallbackProvider: string | null,
): SubagentActions {
  const paseo = usePaseo();
  const generationRef = useRef(0);
  const requestSeqRef = useRef(0);
  const seedEpochRef = useRef(Date.now());
  const hiddenByParentRef = useRef(new Map<string, Set<string>>());
  const [paseoAgents, setPaseoAgents] = useState<PaseoSubagentAgentLike[]>([]);
  const [providerDescriptors, setProviderDescriptors] = useState<
    Map<string, ProviderSubagentDescriptorLike>
  >(new Map());
  const [hiddenProviderIds, setHiddenProviderIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(
    async (): Promise<void> => {
      if (!parentAgentId) return;
      const generation = generationRef.current;
      const request = ++requestSeqRef.current;
      try {
        const result = await paseo.agents.list({
          filter: {
            labels: { [PARENT_AGENT_ID_LABEL]: parentAgentId },
            includeArchived: false,
            includeInternal: false,
            includeBackground: true,
          },
          sort: [{ key: "created_at", direction: "asc" }],
        });
        if (generation !== generationRef.current || request !== requestSeqRef.current) return;
        const next: PaseoSubagentAgentLike[] = [];
        for (const entry of result.entries) {
          const agent = entry.agent;
          if (agent.labels?.[PARENT_AGENT_ID_LABEL] !== parentAgentId) continue;
          next.push({
            id: agent.id,
            title: agent.title,
            provider: agent.provider,
            model: agent.model,
            status: agent.status,
            pendingPermissionCount: agent.pendingPermissions?.length ?? 0,
            requiresAttention: agent.requiresAttention,
            attentionReason: agent.attentionReason ?? null,
            createdAt: agent.createdAt,
            updatedAt: agent.updatedAt,
          });
        }
        setPaseoAgents(next);
      } catch {
        // Keep the last good list when the daemon is briefly unavailable.
      }
    },
    [paseo, parentAgentId],
  );

  useEffect(() => {
    generationRef.current += 1;
    requestSeqRef.current += 1;
    seedEpochRef.current = Date.now();
    setProviderDescriptors(new Map());
    setHiddenProviderIds(
      new Set(parentAgentId ? hiddenByParentRef.current.get(parentAgentId) ?? [] : []),
    );
    if (!parentAgentId) {
      setPaseoAgents([]);
      return;
    }
    setPaseoAgents([]);
    void refresh();
    const timer = setInterval(() => void refresh(), PASEO_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [parentAgentId, refresh]);

  useEffect(() => {
    if (!parentAgentId) return;
    let observation: ReturnType<typeof paseo.observeEvents> | null = null;
    let unsubscribe: (() => void) | null = null;
    try {
      observation = paseo.observeEvents(["agent.provider_subagents.update"]);
      unsubscribe = observation.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type !== "agent.provider_subagents.update") return;
          const payload = message.payload as unknown as ProviderSubagentUpdate;
          if (payload.kind === "upsert") {
            const descriptor = payload.subagent;
            if (descriptor.parentAgentId !== parentAgentId) return;
            setProviderDescriptors((current) => {
              const next = new Map(current);
              next.set(descriptor.id, descriptor);
              return next;
            });
            if (descriptor.status === "running") {
              setHiddenProviderIds((current) => {
                if (!current.has(descriptor.id)) return current;
                const next = new Set(current);
                next.delete(descriptor.id);
                hiddenByParentRef.current.set(parentAgentId, next);
                return next;
              });
            }
            return;
          }
          if (payload.parentAgentId !== parentAgentId) return;
          if (payload.kind === "remove") {
            setProviderDescriptors((current) => {
              if (!current.has(payload.subagentId)) return current;
              const next = new Map(current);
              next.delete(payload.subagentId);
              return next;
            });
          }
        },
      });
    } catch {
      // Provider subagents are optional; Paseo child agents still work.
    }
    return () => {
      unsubscribe?.();
      void observation?.release().catch(() => {});
    };
  }, [paseo, parentAgentId]);

  const timelineRows = useMemo(
    () =>
      parentAgentId
        ? providerRowsFromTimeline(
            items,
            parentAgentId,
            fallbackProvider,
            seedEpochRef.current,
          )
        : [],
    [items, parentAgentId, fallbackProvider],
  );

  const descriptors = useMemo(
    () => [...providerDescriptors.values()],
    [providerDescriptors],
  );

  const rows = useMemo(
    () =>
      parentAgentId
        ? mergeSubagentRows({
            parentAgentId,
            paseoAgents,
            providerDescriptors: descriptors,
            timelineRows,
            hiddenProviderIds,
            now: seedEpochRef.current,
          })
        : [],
    [parentAgentId, paseoAgents, descriptors, timelineRows, hiddenProviderIds],
  );

  const summary = useMemo(() => summarizeSubagents(rows), [rows]);
  const finishedCount = useMemo(() => countFinishedSubagents(rows), [rows]);

  const archivePaseoSubagent = useCallback(
    async (agentId: string): Promise<void> => {
      await paseo.agents.ref(agentId).archive();
      await refresh();
    },
    [paseo, refresh],
  );

  const detachPaseoSubagent = useCallback(
    async (agentId: string): Promise<void> => {
      await paseo.agents.ref(agentId).detach();
      await refresh();
    },
    [paseo, refresh],
  );

  const archiveFinished = useCallback(async (): Promise<{
    archived: number;
    dismissed: number;
  }> => {
    const finished = rows.filter(isFinishedSubagent);
    let archived = 0;
    let dismissed = 0;
    for (const row of finished) {
      if (row.kind === "paseo") {
        await paseo.agents.ref(row.id).archive();
        archived += 1;
      } else {
        dismissed += 1;
      }
    }
    if (dismissed > 0) {
      setHiddenProviderIds((current) => {
        const next = new Set(current);
        for (const row of finished) {
          if (row.kind === "provider") next.add(row.id);
        }
        if (parentAgentId) hiddenByParentRef.current.set(parentAgentId, next);
        return next;
      });
    }
    await refresh();
    return { archived, dismissed };
  }, [paseo, refresh, rows]);

  return {
    rows,
    summary,
    finishedCount,
    archivePaseoSubagent,
    detachPaseoSubagent,
    archiveFinished,
  };
}
