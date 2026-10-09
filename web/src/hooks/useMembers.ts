import { useQuery } from "@tanstack/react-query";

import type { OfficeMember, OfficeMembersMeta } from "../api/client";
import { getMembers, getOfficeMembers } from "../api/client";
import type { MemberAvatar } from "../api/memberTypes";

export function useOfficeMembers() {
  return useQuery({
    queryKey: ["office-members"],
    queryFn: () => getOfficeMembers(),
    refetchInterval: 5000,
    select: (data) =>
      (data.members ?? []).map((m) => {
        const trimmed = m.task?.trim();
        // Normalise at the source: coerce whitespace-only task strings to
        // undefined so every consumer gets a clean value without defensive
        // .trim() calls downstream.
        return trimmed ? { ...m, task: trimmed } : { ...m, task: undefined };
      }),
  });
}

/**
 * One member's chosen look, read from the office roster. For avatar sites that
 * only know a slug (a byline, an audit row, a data-space owner): a site that
 * already holds the member passes `member.avatar` straight through instead.
 * Shares the `office-members` cache, so this adds no request of its own.
 */
export function useMemberAvatar(slug: string): MemberAvatar | undefined {
  const { data: members } = useOfficeMembers();
  return members?.find((m) => m.slug === slug)?.avatar;
}

/**
 * Returns the `meta` payload from `/office-members` (Lane A: humanHasPosted).
 * Reuses the same query key as `useOfficeMembers` so both hooks share a single
 * cached request — there is no extra network round-trip.
 */
export function useOfficeMembersMeta() {
  return useQuery({
    queryKey: ["office-members"],
    queryFn: () => getOfficeMembers(),
    refetchInterval: 5000,
    select: (data): OfficeMembersMeta | undefined => data.meta,
  });
}

export function useChannelMembers(channel: string | null) {
  // `channel` is allowed to be null so callers reachable from off-conversation
  // routes (e.g. BotPanel mounted in Shell) don't have to invent a stub
  // channel just to satisfy this signature. With no channel there is no
  // membership to fetch — react-query keeps the query idle and the caller
  // gets the default `data: []` shape.
  return useQuery({
    queryKey: ["channel-members", channel ?? ""],
    queryFn: () => getMembers(channel ?? ""),
    refetchInterval: 5000,
    enabled: typeof channel === "string" && channel.length > 0,
    select: (data) => data.members ?? [],
  });
}

export type { OfficeMember };
