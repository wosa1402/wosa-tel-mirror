"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { ExternalLink, FileText, Image, Music, Video } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";
import { type LocalQueryPreset } from "@/lib/local-presets";
import { deleteQueryPreset, loadQueryPresets, saveQueryPreset } from "@/lib/query-presets";

type MessageStatus = "pending" | "success" | "failed" | "skipped";
type MessageType =
  | "text"
  | "photo"
  | "video"
  | "document"
  | "audio"
  | "voice"
  | "animation"
  | "sticker"
  | "other";

type ChannelOption = {
  id: string;
  groupName: string;
  channelIdentifier: string;
  name: string;
  username: string | null;
};

type MessageItem = {
  id: string;
  editMappingId: string | null;
  sourceChannelId: string;
  sourceMessageId: number;
  mirrorChannelId: string;
  mirrorMessageId: number | null;
  messageType: MessageType;
  mediaGroupId: string | null;
  groupSize: number;
  status: MessageStatus;
  skipReason: string | null;
  errorMessage: string | null;
  retryCount: number;
  hasMedia: boolean;
  fileSize: number | null;
  textPreview: string | null;
  text: string | null;
  sentAt: string;
  mirroredAt: string | null;
  isDeleted: boolean;
  deletedAt: string | null;
  editCount: number;
  lastEditedAt: string | null;
  sourceChannel: {
    id: string;
    channelIdentifier: string;
    telegramId: string | null;
    username: string | null;
    name: string;
  };
  mirrorChannel: {
    id: string;
    channelIdentifier: string;
    telegramId: string | null;
    username: string | null;
    name: string;
  };
  links: {
    source: string | null;
    mirror: string | null;
  };
};

const UNGROUPED = "__ungrouped__";
const PRESETS_STORAGE_KEY = "tg-back:presets:messages";

const messageIconMap: Record<MessageType, typeof FileText> = {
  text: FileText,
  photo: Image,
  video: Video,
  document: FileText,
  audio: Music,
  voice: Music,
  animation: Video,
  sticker: Image,
  other: FileText,
};

const messageColorMap: Record<MessageType, string> = {
  text: "bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-200",
  photo: "bg-green-100 text-green-600 dark:bg-green-500/15 dark:text-green-200",
  video: "bg-purple-100 text-purple-600 dark:bg-purple-500/15 dark:text-purple-200",
  document: "bg-orange-100 text-orange-600 dark:bg-orange-500/15 dark:text-orange-200",
  audio: "bg-pink-100 text-pink-600 dark:bg-pink-500/15 dark:text-pink-200",
  voice: "bg-pink-100 text-pink-600 dark:bg-pink-500/15 dark:text-pink-200",
  animation: "bg-purple-100 text-purple-600 dark:bg-purple-500/15 dark:text-purple-200",
  sticker: "bg-green-100 text-green-600 dark:bg-green-500/15 dark:text-green-200",
  other: "bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-200",
};

type MessageEditItem = {
  id: string;
  messageMappingId: string;
  version: number;
  previousText: string | null;
  newText: string | null;
  editedAt: string;
  createdAt: string;
};

type MediaGroupItem = {
  id: string;
  sourceMessageId: number;
  mirrorMessageId: number | null;
  messageType: MessageType;
  status: MessageStatus;
  skipReason: string | null;
  errorMessage: string | null;
  retryCount: number;
  hasMedia: boolean;
  fileSize: number | null;
  textPreview: string | null;
  text: string | null;
  sentAt: string;
  mirroredAt: string | null;
  links: {
    source: string | null;
    mirror: string | null;
  };
};

type Cursor = {
  sentAt: string;
  sourceChannelId: string;
  sourceMessageId: number;
} | null;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN");
}

function formatFileSize(bytes: number | null): string | null {
  if (bytes == null) return null;
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)}MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 2 : 1)}GB`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(text: string, rawQuery: string): ReactNode {
  const query = rawQuery.trim();
  if (!query) return text;

  const keywords = query
    .split(/\s+/g)
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (!keywords.length) return text;

  const keywordSet = new Set(keywords.map((k) => k.toLowerCase()));
  const regex = new RegExp(`(${keywords.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(regex);
  if (parts.length <= 1) return text;

  return parts.map((part, index) => {
    const key = `${index}-${part}`;
    if (keywordSet.has(part.toLowerCase())) {
      return (
        <mark key={key} className="rounded bg-yellow-200/70 px-0.5 dark:bg-yellow-500/20 dark:text-yellow-200">
          {part}
        </mark>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

const MESSAGE_TYPE_LABEL: Record<MessageType, string> = {
  text: "文本",
  photo: "图片",
  video: "视频",
  document: "文件",
  audio: "音频",
  voice: "语音",
  animation: "动图",
  sticker: "贴纸",
  other: "其他",
};

const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  pending: "待处理",
  success: "成功",
  failed: "失败",
  skipped: "已跳过",
};

const SKIP_REASON_LABEL: Record<string, string> = {
  protected_content: "受保护内容",
  file_too_large: "文件过大",
  unsupported_type: "不支持的类型",
  rate_limited_skip: "限流跳过",
  failed_too_many_times: "重试次数过多",
  message_deleted: "源消息已撤回",
  filtered: "广告/垃圾过滤",
};

function labelMessageType(type: MessageType): string {
  return MESSAGE_TYPE_LABEL[type] ?? type;
}

function labelMessageStatus(status: MessageStatus): string {
  return MESSAGE_STATUS_LABEL[status] ?? status;
}

function labelSkipReason(reason: string): string {
  return SKIP_REASON_LABEL[reason] ?? reason;
}

const EDITED_GRACE_MS = 60_000;

function isEditedAfterMirror(message: MessageItem): boolean {
  if (message.editCount <= 0) return false;
  if (!message.lastEditedAt) return false;
  if (!message.mirroredAt) return true;
  const editedAt = new Date(message.lastEditedAt);
  const mirroredAt = new Date(message.mirroredAt);
  if (Number.isNaN(editedAt.getTime()) || Number.isNaN(mirroredAt.getTime())) return true;
  return editedAt.getTime() + EDITED_GRACE_MS > mirroredAt.getTime();
}

export function MessagesBrowser() {
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [groupFilter, setGroupFilter] = useState<string>("");
  const [selectedChannelId, setSelectedChannelId] = useState<string>("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("");
  const [messageType, setMessageType] = useState<string>("");
  const [hasMediaFilter, setHasMediaFilter] = useState<string>("");
  const [skipReasonFilter, setSkipReasonFilter] = useState<string>("");
  const [editedFilter, setEditedFilter] = useState<string>("");
  const [deletedFilter, setDeletedFilter] = useState<string>("");
  const [minFileSizeMb, setMinFileSizeMb] = useState<string>("");
  const [maxFileSizeMb, setMaxFileSizeMb] = useState<string>("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [limit, setLimit] = useState(50);
  const [groupMedia, setGroupMedia] = useState(true);

  const [items, setItems] = useState<MessageItem[]>([]);
  const [nextCursor, setNextCursor] = useState<Cursor>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const noticeTimerRef = useRef<number | null>(null);

  const exportUrl = useMemo(() => {
    if (!selectedChannelId) return null;
    const params = new URLSearchParams({ sourceChannelId: selectedChannelId, groupMedia: groupMedia ? "true" : "false" });
    if (q.trim()) params.set("q", q.trim());
    if (status.trim()) params.set("status", status.trim());
    if (messageType.trim()) params.set("messageType", messageType.trim());
    if (hasMediaFilter.trim()) params.set("hasMedia", hasMediaFilter.trim());
    if (skipReasonFilter.trim()) params.set("skipReason", skipReasonFilter.trim());
    if (editedFilter.trim()) params.set("edited", editedFilter.trim());
    if (deletedFilter.trim()) params.set("isDeleted", deletedFilter.trim());
    if (minFileSizeMb.trim()) params.set("minFileSizeMb", minFileSizeMb.trim());
    if (maxFileSizeMb.trim()) params.set("maxFileSizeMb", maxFileSizeMb.trim());
    if (start.trim()) params.set("start", start.trim());
    if (end.trim()) params.set("end", end.trim());
    return `/api/export/messages?${params.toString()}`;
  }, [selectedChannelId, groupMedia, q, status, messageType, hasMediaFilter, skipReasonFilter, editedFilter, deletedFilter, minFileSizeMb, maxFileSizeMb, start, end]);

  const [openEditHistoryId, setOpenEditHistoryId] = useState<string | null>(null);
  const [editHistoryByMessageId, setEditHistoryByMessageId] = useState<Record<string, MessageEditItem[]>>({});
  const [editHistoryLoadingId, setEditHistoryLoadingId] = useState<string | null>(null);
  const [editHistoryErrorByMessageId, setEditHistoryErrorByMessageId] = useState<Record<string, string>>({});
  const [editHistoryFetchedAtEditCountByMessageId, setEditHistoryFetchedAtEditCountByMessageId] = useState<
    Record<string, number>
  >({});

  const [expandedTextByMessageId, setExpandedTextByMessageId] = useState<Record<string, boolean>>({});

  const [openMediaGroupKey, setOpenMediaGroupKey] = useState<string | null>(null);
  const [mediaGroupItemsByKey, setMediaGroupItemsByKey] = useState<Record<string, MediaGroupItem[]>>({});
  const [mediaGroupLoadingKey, setMediaGroupLoadingKey] = useState<string | null>(null);
  const [mediaGroupErrorByKey, setMediaGroupErrorByKey] = useState<Record<string, string>>({});

  const [savedPresets, setSavedPresets] = useState<LocalQueryPreset[]>([]);

  const autoFetchPending = useRef(false);
  const didAutoFetch = useRef(false);
  const multiChannelCacheRef = useRef<Record<string, { items: MessageItem[]; nextCursor: Cursor }>>({});
  const fetchMessagesRef = useRef<(args: { reset: boolean; overrideChannelId?: string }) => Promise<void>>(async () => {});
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const canLoadMoreRef = useRef(false);
  const autoLoadMoreInFlightRef = useRef(false);

  const canLoadMore = useMemo(() => !!nextCursor && !loading, [nextCursor, loading]);
  canLoadMoreRef.current = canLoadMore;

  const showNotice = (message: string) => {
    setNotice(message);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(""), 3000);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const presets = await loadQueryPresets({ scope: "messages", storageKey: PRESETS_STORAGE_KEY });
      if (!cancelled) setSavedPresets(presets);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const groupOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of channels) {
      const name = (c.groupName ?? "").trim();
      if (name) set.add(name);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [channels]);

  const hasUngrouped = useMemo(() => channels.some((c) => !(c.groupName ?? "").trim()), [channels]);

  const visibleChannels = useMemo(() => {
    const g = groupFilter.trim();
    if (!g) return channels;
    if (g === UNGROUPED) return channels.filter((c) => !(c.groupName ?? "").trim());
    return channels.filter((c) => (c.groupName ?? "").trim() === g);
  }, [channels, groupFilter]);

  const loadChannels = async (): Promise<ChannelOption[]> => {
    setChannelsLoading(true);
    try {
      const res = await fetch("/api/channels?mode=options", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load channels");
      const rows = (data.channels ?? []) as Array<{
        id: string;
        groupName?: string;
        channelIdentifier: string;
        name: string;
        username?: string | null;
      }>;
      const mapped: ChannelOption[] = rows.map((r) => ({
        id: r.id,
        groupName: typeof r.groupName === "string" ? r.groupName : "",
        channelIdentifier: r.channelIdentifier,
        name: r.name,
        username: r.username ?? null,
      }));
      setChannels(mapped);
      return mapped;
    } catch (e: unknown) {
      setError(getErrorMessage(e));
      return [];
    } finally {
      setChannelsLoading(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialChannelId = params.get("sourceChannelId")?.trim() ?? "";
    const hasGroupParam = params.has("groupName") || params.has("group_name");
    const initialGroupRaw = (params.get("groupName") ?? params.get("group_name") ?? "").trim();
    const initialQ = params.get("q")?.trim() ?? "";
    const initialStatus = params.get("status")?.trim() ?? "";
    const initialMessageType = params.get("messageType")?.trim() ?? "";
    const initialHasMedia = (params.get("hasMedia") ?? params.get("has_media") ?? "").trim();
    const initialSkipReason = (params.get("skipReason") ?? params.get("skip_reason") ?? "").trim();
    const initialEdited = (params.get("edited") ?? "").trim();
    const initialDeleted = (params.get("isDeleted") ?? params.get("is_deleted") ?? params.get("deleted") ?? "").trim();
    const initialMinFileSizeMb = (params.get("minFileSizeMb") ?? params.get("min_file_size_mb") ?? "").trim();
    const initialMaxFileSizeMb = (params.get("maxFileSizeMb") ?? params.get("max_file_size_mb") ?? "").trim();
    const initialStart = params.get("start")?.trim() ?? "";
    const initialEnd = params.get("end")?.trim() ?? "";
    const initialLimit = params.get("limit")?.trim() ?? "";
    const initialGroupMedia = (params.get("groupMedia") ?? params.get("group_media") ?? "").trim();
    const parsedLimit = initialLimit ? Number.parseInt(initialLimit, 10) : NaN;
    const shouldAutoFetch = !!(
      params.get("sourceChannelId") ||
      hasGroupParam ||
      params.get("q") ||
      params.get("status") ||
      params.get("messageType") ||
      params.get("hasMedia") ||
      params.get("has_media") ||
      params.get("skipReason") ||
      params.get("skip_reason") ||
      params.get("edited") ||
      params.get("isDeleted") ||
      params.get("is_deleted") ||
      params.get("deleted") ||
      params.get("minFileSizeMb") ||
      params.get("min_file_size_mb") ||
      params.get("maxFileSizeMb") ||
      params.get("max_file_size_mb") ||
      params.get("groupMedia") ||
      params.get("group_media") ||
      params.get("start") ||
      params.get("end")
    );

    autoFetchPending.current = shouldAutoFetch;
    didAutoFetch.current = false;

    const initialGroupFilter = hasGroupParam ? (initialGroupRaw ? initialGroupRaw : UNGROUPED) : "";
    if (initialGroupFilter) setGroupFilter(initialGroupFilter);

    if (initialQ) setQ(initialQ);
    if (initialStatus) setStatus(initialStatus);
    if (initialMessageType) setMessageType(initialMessageType);
    if (initialHasMedia) setHasMediaFilter(initialHasMedia);
    if (initialSkipReason) setSkipReasonFilter(initialSkipReason);
    if (initialEdited) setEditedFilter(initialEdited);
    if (initialDeleted) setDeletedFilter(initialDeleted);
    if (initialMinFileSizeMb) setMinFileSizeMb(initialMinFileSizeMb);
    if (initialMaxFileSizeMb) setMaxFileSizeMb(initialMaxFileSizeMb);
    if (initialStart) setStart(initialStart);
    if (initialEnd) setEnd(initialEnd);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) setLimit(Math.min(Math.max(parsedLimit, 1), 200));
    if (initialGroupMedia) setGroupMedia(initialGroupMedia.toLowerCase() !== "false");

    loadChannels()
      .then((rows) => {
        const hasValidInitialChannel = initialChannelId && rows.some((c) => c.id === initialChannelId);
        if (hasValidInitialChannel) {
          setSelectedChannelId(initialChannelId);
          return;
        }

        if (initialGroupFilter) {
          setSelectedChannelId("");
          return;
        }

        const fallback = rows.length ? rows[0]!.id : "";
        if (fallback) setSelectedChannelId(fallback);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedChannelId && !groupFilter.trim()) return;
    if (!autoFetchPending.current) return;
    if (didAutoFetch.current) return;
    didAutoFetch.current = true;
    autoFetchPending.current = false;
    fetchMessages({ reset: true }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannelId, groupFilter]);

  useEffect(() => {
    if (selectedChannelId !== "") return;
    const signature = buildQuery(null, "");
    const cached = multiChannelCacheRef.current[signature];
    if (!cached) {
      setItems([]);
      setNextCursor(null);
      return;
    }
    setItems(cached.items ?? []);
    setNextCursor(cached.nextCursor ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupFilter, selectedChannelId]);

  const buildQuery = (
    cursor: Cursor,
    channelId: string,
    overrides: Partial<{
      groupFilter: string;
      q: string;
      status: string;
      messageType: string;
      hasMediaFilter: string;
      skipReasonFilter: string;
      editedFilter: string;
      deletedFilter: string;
      minFileSizeMb: string;
      maxFileSizeMb: string;
      start: string;
      end: string;
      groupMedia: boolean;
      limit: number;
    }> = {},
  ): string => {
    const groupFilterEffective = overrides.groupFilter ?? groupFilter;
    const qEffective = overrides.q ?? q;
    const statusEffective = overrides.status ?? status;
    const messageTypeEffective = overrides.messageType ?? messageType;
    const hasMediaEffective = overrides.hasMediaFilter ?? hasMediaFilter;
    const skipReasonEffective = overrides.skipReasonFilter ?? skipReasonFilter;
    const editedEffective = overrides.editedFilter ?? editedFilter;
    const deletedEffective = overrides.deletedFilter ?? deletedFilter;
    const minFileSizeMbEffective = overrides.minFileSizeMb ?? minFileSizeMb;
    const maxFileSizeMbEffective = overrides.maxFileSizeMb ?? maxFileSizeMb;
    const startEffective = overrides.start ?? start;
    const endEffective = overrides.end ?? end;
    const groupMediaEffective = overrides.groupMedia ?? groupMedia;
    const limitEffective = overrides.limit ?? limit;

    const params = new URLSearchParams();
    if (channelId) params.set("sourceChannelId", channelId);
    else if (groupFilterEffective === UNGROUPED) params.set("groupName", "");
    else if (groupFilterEffective.trim()) params.set("groupName", groupFilterEffective.trim());
    if (qEffective.trim()) params.set("q", qEffective.trim());
    if (statusEffective) params.set("status", statusEffective);
    if (messageTypeEffective) params.set("messageType", messageTypeEffective);
    if (hasMediaEffective.trim()) params.set("hasMedia", hasMediaEffective.trim());
    if (skipReasonEffective.trim()) params.set("skipReason", skipReasonEffective.trim());
    if (editedEffective.trim()) params.set("edited", editedEffective.trim());
    if (deletedEffective.trim()) params.set("isDeleted", deletedEffective.trim());
    if (minFileSizeMbEffective.trim()) params.set("minFileSizeMb", minFileSizeMbEffective.trim());
    if (maxFileSizeMbEffective.trim()) params.set("maxFileSizeMb", maxFileSizeMbEffective.trim());
    if (startEffective) params.set("start", startEffective);
    if (endEffective) params.set("end", endEffective);
    params.set("groupMedia", groupMediaEffective ? "true" : "false");
    params.set("limit", String(limitEffective));
    if (cursor) {
      params.set("cursorSentAt", cursor.sentAt);
      params.set("cursorSourceChannelId", cursor.sourceChannelId);
      params.set("cursorSourceMessageId", String(cursor.sourceMessageId));
    }
    return params.toString();
  };

  const buildShareUrl = (overrideChannelId?: string, overrides?: Parameters<typeof buildQuery>[2]): string => {
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    const query = buildQuery(null, overrideChannelId ?? selectedChannelId, overrides);
    url.search = query ? `?${query}` : "";
    return url.toString();
  };

  const saveCurrentAsPreset = async () => {
    const currentQuery = buildQuery(null, selectedChannelId);

    const channelName = selectedChannelId ? channels.find((c) => c.id === selectedChannelId)?.name ?? "" : "";
    const groupLabel = groupFilter === UNGROUPED ? "未分组" : groupFilter.trim();
    const parts: string[] = [];
    if (channelName) parts.push(channelName);
    else if (groupLabel) parts.push(`分组:${groupLabel}`);
    else parts.push("全部频道");
    if (q.trim()) parts.push(`关键词:${q.trim().slice(0, 12)}`);
    if (status) parts.push(status);
    const suggested = parts.join(" ");

    const name = window.prompt("给这个预设起个名字：", suggested)?.trim() ?? "";
    if (!name) return;

    const next = await saveQueryPreset({ scope: "messages", name, query: currentQuery, storageKey: PRESETS_STORAGE_KEY });
    setSavedPresets(next);
    showNotice("已保存预设");
  };

  const deletePreset = async (id: string) => {
    const next = await deleteQueryPreset({ scope: "messages", id, storageKey: PRESETS_STORAGE_KEY });
    setSavedPresets(next);
    showNotice("已删除预设");
  };

  const applyPresetQueryString = (query: string) => {
    const params = new URLSearchParams(query);

    const nextChannelId = params.get("sourceChannelId")?.trim() ?? "";
    const hasGroupParam = params.has("groupName") || params.has("group_name");
    const groupRaw = (params.get("groupName") ?? params.get("group_name") ?? "").trim();
    const nextGroupFilter = nextChannelId ? "" : hasGroupParam ? (groupRaw ? groupRaw : UNGROUPED) : "";

    const nextQ = params.get("q")?.trim() ?? "";
    const nextStatus = params.get("status")?.trim() ?? "";
    const nextMessageType = params.get("messageType")?.trim() ?? "";
    const nextHasMedia = (params.get("hasMedia") ?? params.get("has_media") ?? "").trim();
    const nextSkipReason = (params.get("skipReason") ?? params.get("skip_reason") ?? "").trim();
    const nextEdited = (params.get("edited") ?? "").trim();
    const nextDeleted = (params.get("isDeleted") ?? params.get("is_deleted") ?? params.get("deleted") ?? "").trim();
    const nextMinFileSizeMb = (params.get("minFileSizeMb") ?? params.get("min_file_size_mb") ?? "").trim();
    const nextMaxFileSizeMb = (params.get("maxFileSizeMb") ?? params.get("max_file_size_mb") ?? "").trim();
    const nextStart = params.get("start")?.trim() ?? "";
    const nextEnd = params.get("end")?.trim() ?? "";
    const groupMediaRaw = (params.get("groupMedia") ?? params.get("group_media") ?? "").trim();
    const limitRaw = params.get("limit")?.trim() ?? "";

    const nextGroupMedia = groupMediaRaw ? groupMediaRaw.toLowerCase() !== "false" : true;
    const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
    const nextLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.max(parsedLimit, 1), 200) : 50;

    const overrides: NonNullable<Parameters<typeof buildQuery>[2]> = {
      groupFilter: nextGroupFilter,
      q: nextQ,
      status: nextStatus,
      messageType: nextMessageType,
      hasMediaFilter: nextHasMedia,
      skipReasonFilter: nextSkipReason,
      editedFilter: nextEdited,
      deletedFilter: nextDeleted,
      minFileSizeMb: nextMinFileSizeMb,
      maxFileSizeMb: nextMaxFileSizeMb,
      start: nextStart,
      end: nextEnd,
      groupMedia: nextGroupMedia,
      limit: nextLimit,
    };

    setNotice("");
    setOpenEditHistoryId(null);
    setOpenMediaGroupKey(null);
    window.history.replaceState(null, "", buildShareUrl(nextChannelId, overrides));
    void fetchMessages({ reset: true, overrideChannelId: nextChannelId, overrides });

    setSelectedChannelId(nextChannelId);
    setGroupFilter(nextGroupFilter);
    setQ(nextQ);
    setStatus(nextStatus);
    setMessageType(nextMessageType);
    setHasMediaFilter(nextHasMedia);
    setSkipReasonFilter(nextSkipReason);
    setEditedFilter(nextEdited);
    setDeletedFilter(nextDeleted);
    setMinFileSizeMb(nextMinFileSizeMb);
    setMaxFileSizeMb(nextMaxFileSizeMb);
    setStart(nextStart);
    setEnd(nextEnd);
    setGroupMedia(nextGroupMedia);
    setLimit(nextLimit);
  };

  const syncUrlToCurrentQuery = (overrideChannelId?: string, overrides?: Parameters<typeof buildQuery>[2]) => {
    const nextUrl = buildShareUrl(overrideChannelId, overrides);
    if (!nextUrl) return;
    window.history.replaceState(null, "", nextUrl);
  };

  const copyQueryLink = async () => {
    const url = buildShareUrl();
    if (!url) return;
    syncUrlToCurrentQuery();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        showNotice("已复制查询链接");
        return;
      }
      throw new Error("clipboard not available");
    } catch {
      window.prompt("复制下面这个链接（手动复制）：", url);
    }
  };

  const fetchMessages = async ({
    reset,
    overrideChannelId,
    overrides,
  }: {
    reset: boolean;
    overrideChannelId?: string;
    overrides?: Parameters<typeof buildQuery>[2];
  }) => {
    const channelId = overrideChannelId ?? selectedChannelId;
    if (!channelId && !channels.length) return;
    setLoading(true);
    setError("");
    try {
      const cursor = reset ? null : nextCursor;
      const query = buildQuery(cursor, channelId, overrides);
      const res = await fetch(`/api/messages?${query}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load messages");

      const newItems = (data.items ?? []) as MessageItem[];
      const newCursor = (data.nextCursor ?? null) as Cursor;
      const multiChannelSignature = !channelId ? buildQuery(null, "", overrides) : null;

      setItems((prev) => {
        const merged = reset ? newItems : [...prev, ...newItems];
        if (!channelId && multiChannelSignature) {
          multiChannelCacheRef.current[multiChannelSignature] = { items: merged, nextCursor: newCursor };
        }
        return merged;
      });
      setNextCursor(newCursor);
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const applyPreset = (overrides: NonNullable<Parameters<typeof buildQuery>[2]> = {}) => {
    setNotice("");
    setOpenEditHistoryId(null);
    setOpenMediaGroupKey(null);
    syncUrlToCurrentQuery(undefined, overrides);
    void fetchMessages({ reset: true, overrides });

    if (typeof overrides.q !== "undefined") setQ(overrides.q);
    if (typeof overrides.status !== "undefined") setStatus(overrides.status);
    if (typeof overrides.messageType !== "undefined") setMessageType(overrides.messageType);
    if (typeof overrides.hasMediaFilter !== "undefined") setHasMediaFilter(overrides.hasMediaFilter);
    if (typeof overrides.skipReasonFilter !== "undefined") setSkipReasonFilter(overrides.skipReasonFilter);
    if (typeof overrides.editedFilter !== "undefined") setEditedFilter(overrides.editedFilter);
    if (typeof overrides.deletedFilter !== "undefined") setDeletedFilter(overrides.deletedFilter);
    if (typeof overrides.minFileSizeMb !== "undefined") setMinFileSizeMb(overrides.minFileSizeMb);
    if (typeof overrides.maxFileSizeMb !== "undefined") setMaxFileSizeMb(overrides.maxFileSizeMb);
    if (typeof overrides.start !== "undefined") setStart(overrides.start);
    if (typeof overrides.end !== "undefined") setEnd(overrides.end);
    if (typeof overrides.groupMedia !== "undefined") setGroupMedia(overrides.groupMedia);
    if (typeof overrides.limit !== "undefined") setLimit(overrides.limit);
  };

  fetchMessagesRef.current = fetchMessages;

  useEffect(() => {
    const el = loadMoreSentinelRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (!canLoadMoreRef.current) return;
        if (autoLoadMoreInFlightRef.current) return;

        autoLoadMoreInFlightRef.current = true;
        void fetchMessagesRef
          .current({ reset: false })
          .catch(() => {})
          .finally(() => {
            autoLoadMoreInFlightRef.current = false;
          });
      },
      { root: null, rootMargin: "600px 0px", threshold: 0 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!canLoadMore) return;
    const el = loadMoreSentinelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.top > window.innerHeight + 300) return;
    if (autoLoadMoreInFlightRef.current) return;

    autoLoadMoreInFlightRef.current = true;
    void fetchMessagesRef
      .current({ reset: false })
      .catch(() => {})
      .finally(() => {
        autoLoadMoreInFlightRef.current = false;
      });
  }, [canLoadMore]);

  const toggleEditHistory = async (messageMappingId: string, expectedEditCount?: number) => {
    if (openEditHistoryId === messageMappingId) {
      setOpenEditHistoryId(null);
      return;
    }

    setOpenEditHistoryId(messageMappingId);

    const cached = editHistoryByMessageId[messageMappingId];
    if (cached) {
      if (typeof expectedEditCount !== "number") return;
      const fetchedAtEditCount = editHistoryFetchedAtEditCountByMessageId[messageMappingId];
      if (typeof fetchedAtEditCount === "number" && fetchedAtEditCount >= expectedEditCount) return;
    }

    setEditHistoryLoadingId(messageMappingId);
    setEditHistoryErrorByMessageId((prev) => ({ ...prev, [messageMappingId]: "" }));
    try {
      const res = await fetch(`/api/message-edits?messageMappingId=${encodeURIComponent(messageMappingId)}&limit=50`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const details = [data.error, data.cause].filter(Boolean).join("\n");
        throw new Error(details || "Failed to load edit history");
      }
      const edits = (data.edits ?? []) as MessageEditItem[];
      setEditHistoryByMessageId((prev) => ({ ...prev, [messageMappingId]: edits }));
      setEditHistoryFetchedAtEditCountByMessageId((prev) => ({
        ...prev,
        [messageMappingId]: typeof expectedEditCount === "number" ? expectedEditCount : edits.length,
      }));
    } catch (e: unknown) {
      setEditHistoryErrorByMessageId((prev) => ({ ...prev, [messageMappingId]: getErrorMessage(e) }));
    } finally {
      setEditHistoryLoadingId(null);
    }
  };

  const toggleExpandedText = (messageId: string) => {
    setExpandedTextByMessageId((prev) => ({ ...prev, [messageId]: !(prev[messageId] ?? false) }));
  };

  const toggleMediaGroup = async (message: MessageItem) => {
    if (!message.mediaGroupId || message.groupSize <= 1) return;
    const key = `${message.sourceChannelId}:${message.mediaGroupId}`;
    if (openMediaGroupKey === key) {
      setOpenMediaGroupKey(null);
      return;
    }

    setOpenMediaGroupKey(key);
    setOpenEditHistoryId(null);

    if (mediaGroupItemsByKey[key]) return;

    setMediaGroupLoadingKey(key);
    setMediaGroupErrorByKey((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    try {
      const params = new URLSearchParams({ sourceChannelId: message.sourceChannelId, mediaGroupId: message.mediaGroupId });
      const res = await fetch(`/api/messages/media-group?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to load media group");
      const items = (data.items ?? []) as MediaGroupItem[];
      setMediaGroupItemsByKey((prev) => ({ ...prev, [key]: items }));
    } catch (e: unknown) {
      setMediaGroupErrorByKey((prev) => ({ ...prev, [key]: getErrorMessage(e) }));
    } finally {
      setMediaGroupLoadingKey(null);
    }
  };

  return (
    <div className="space-y-6">
      {error ? (
        <div className="ui-alert-error">{error}</div>
      ) : null}
      {notice ? (
        <div className="ui-alert-info">{notice}</div>
      ) : null}

      <div className="ui-card">
        <h2 className="ui-section-title">查询</h2>
        <div className="mt-4 grid grid-cols-1 gap-3">
          <div>
            <label className="block text-sm font-medium">源频道</label>
            <div className="mt-1">
              <Select
                value={selectedChannelId}
                onChange={(nextId) => {
                  setSelectedChannelId(nextId);
                  setOpenEditHistoryId(null);
                  if (nextId !== "") return;

                  const signature = buildQuery(null, "");
                  const cached = multiChannelCacheRef.current[signature];
                  if (!cached) {
                    setItems([]);
                    setNextCursor(null);
                    return;
                  }

                  setItems(cached.items ?? []);
                  setNextCursor(cached.nextCursor ?? null);
                }}
                disabled={!visibleChannels.length}
                options={
                  visibleChannels.length
                    ? [
                        {
                          value: "",
                          label:
                            groupFilter === UNGROUPED ? "未分组全部频道" : groupFilter.trim() ? "该分组全部频道" : "全部频道",
                        },
                        ...visibleChannels.map((c) => ({
                          value: c.id,
                          label: `${c.name} (${c.channelIdentifier})`,
                        })),
                      ]
                    : [{ value: "", label: channelsLoading ? "（加载中...）" : "（暂无频道）" }]
                }
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium">分组</label>
            <div className="mt-1">
              <Select
                value={groupFilter}
                onChange={(nextGroup) => {
                  setGroupFilter(nextGroup);
                  setOpenEditHistoryId(null);
                  const current = selectedChannelId;
                  if (current) {
                    const found = channels.find((c) => c.id === current);
                    const foundGroup = (found?.groupName ?? "").trim();
                    if (nextGroup === UNGROUPED) {
                      if (foundGroup) setSelectedChannelId("");
                      return;
                    }
                    if (nextGroup && foundGroup !== nextGroup) {
                      setSelectedChannelId("");
                    }
                  }
                }}
                options={[
                  { value: "", label: channelsLoading ? "全部分组（加载中...）" : "全部分组" },
                  ...(hasUngrouped ? [{ value: UNGROUPED, label: "未分组" }] : []),
                  ...groupOptions.map((g) => ({ value: g, label: g })),
                ]}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium">关键词（搜索 text/caption，空格分隔=同时包含）</label>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="例如：BTC 关键词"
              className="ui-input mt-1"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">状态</label>
              <div className="mt-1">
                <Select
                  value={status}
                  onChange={(next) => setStatus(next)}
                  options={[
                    { value: "", label: "全部" },
                    { value: "success", label: "success" },
                    { value: "pending", label: "pending" },
                    { value: "failed", label: "failed" },
                    { value: "skipped", label: "skipped" },
                  ]}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium">类型</label>
              <div className="mt-1">
                <Select
                  value={messageType}
                  onChange={(next) => setMessageType(next)}
                  options={[
                    { value: "", label: "全部" },
                    { value: "text", label: "text" },
                    { value: "photo", label: "photo" },
                    { value: "video", label: "video" },
                    { value: "document", label: "document" },
                    { value: "audio", label: "audio" },
                    { value: "voice", label: "voice" },
                    { value: "animation", label: "animation" },
                    { value: "sticker", label: "sticker" },
                    { value: "other", label: "other" },
                  ]}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">开始时间</label>
              <input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="ui-input mt-1"
              />
            </div>
            <div>
              <label className="block text-sm font-medium">结束时间</label>
              <input
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="ui-input mt-1"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">媒体</label>
              <div className="mt-1">
                <Select
                  value={hasMediaFilter}
                  onChange={(next) => setHasMediaFilter(next)}
                  options={[
                    { value: "", label: "全部" },
                    { value: "true", label: "仅媒体" },
                    { value: "false", label: "仅无媒体" },
                  ]}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium">跳过原因（skipped）</label>
              <div className="mt-1">
                <Select
                  value={skipReasonFilter}
                  onChange={(next) => setSkipReasonFilter(next)}
                  options={[
                    { value: "", label: "全部" },
                    { value: "protected_content", label: "protected_content" },
                    { value: "file_too_large", label: "file_too_large" },
                    { value: "unsupported_type", label: "unsupported_type" },
                    { value: "rate_limited_skip", label: "rate_limited_skip" },
                    { value: "failed_too_many_times", label: "failed_too_many_times" },
                    { value: "message_deleted", label: "message_deleted" },
                    { value: "filtered", label: "filtered" },
                  ]}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">编辑</label>
              <div className="mt-1">
                <Select
                  value={editedFilter}
                  onChange={(next) => setEditedFilter(next)}
                  options={[
                    { value: "", label: "全部" },
                    { value: "true", label: "仅编辑过" },
                    { value: "false", label: "仅未编辑" },
                  ]}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium">撤回</label>
              <div className="mt-1">
                <Select
                  value={deletedFilter}
                  onChange={(next) => setDeletedFilter(next)}
                  options={[
                    { value: "", label: "全部" },
                    { value: "true", label: "仅已撤回" },
                    { value: "false", label: "仅未撤回" },
                  ]}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">文件大小最小（MB）</label>
              <input
                type="number"
                min={0}
                value={minFileSizeMb}
                onChange={(e) => setMinFileSizeMb(e.target.value)}
                placeholder="例如：10"
                className="ui-input mt-1"
              />
            </div>
            <div>
              <label className="block text-sm font-medium">文件大小最大（MB）</label>
              <input
                type="number"
                min={0}
                value={maxFileSizeMb}
                onChange={(e) => setMaxFileSizeMb(e.target.value)}
                placeholder="例如：100"
                className="ui-input mt-1"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 pt-1 text-sm">
            <Checkbox label="合并媒体组（推荐）" checked={groupMedia} onChange={(checked) => setGroupMedia(checked)} />
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white/50 p-4 text-sm dark:border-white/10 dark:bg-slate-900/40">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium">我的预设（保存到服务器）</div>
              <button
                type="button"
                onClick={() => saveCurrentAsPreset()}
                disabled={loading}
                className="ui-btn ui-btn-secondary h-9 px-3 text-xs"
              >
                保存当前为预设
              </button>
            </div>

            {savedPresets.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {savedPresets.map((p) => (
                  <div key={p.id} className="inline-flex overflow-hidden rounded-xl border border-gray-200 bg-white/60 dark:border-white/10 dark:bg-slate-900/40">
                    <button
                      type="button"
                      onClick={() => applyPresetQueryString(p.query)}
                      disabled={loading}
                      className="inline-flex h-9 items-center justify-center px-3 text-xs text-gray-800 hover:bg-white/80 disabled:opacity-50 dark:text-slate-100 dark:hover:bg-white/10"
                      title={p.query}
                    >
                      {p.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => deletePreset(p.id)}
                      disabled={loading}
                      className="inline-flex h-8 items-center justify-center border-l border-black/10 px-2 text-xs text-black/50 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:text-slate-400 dark:hover:bg-white/10"
                      title="删除这个预设"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-2 text-xs text-black/60 dark:text-slate-400">暂无预设：先把筛选条件调好，再点“保存当前为预设”。</div>
            )}

            <div className="mt-3 border-t border-black/10 pt-3 dark:border-white/10">
              <div className="font-medium">内置快捷（点一下就查询）</div>
              <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  applyPreset({
                    status: "",
                    messageType: "",
                    hasMediaFilter: "",
                    skipReasonFilter: "",
                    editedFilter: "",
                    deletedFilter: "",
                  })
                }
                disabled={loading}
                className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
              >
                全部
              </button>
              <button
                type="button"
                onClick={() => applyPreset({ status: "failed", skipReasonFilter: "" })}
                disabled={loading}
                className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
              >
                失败
              </button>
              <button
                type="button"
                onClick={() => applyPreset({ status: "skipped", skipReasonFilter: "" })}
                disabled={loading}
                className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
              >
                已跳过
              </button>
              <button
                type="button"
                onClick={() => applyPreset({ status: "skipped", skipReasonFilter: "protected_content" })}
                disabled={loading}
                className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
              >
                受保护跳过
              </button>
              <button
                type="button"
                onClick={() => applyPreset({ hasMediaFilter: "true", skipReasonFilter: "" })}
                disabled={loading}
                className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
              >
                仅媒体
              </button>
              <button
                type="button"
                onClick={() => applyPreset({ editedFilter: "true", skipReasonFilter: "" })}
                disabled={loading}
                className="ui-btn ui-btn-secondary h-9 px-3 text-xs"
              >
                已编辑
              </button>
              <button
                type="button"
                onClick={() => applyPreset({ deletedFilter: "true", skipReasonFilter: "" })}
                disabled={loading}
                className="ui-btn ui-btn-secondary h-9 px-3 text-xs"
              >
                已撤回
              </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">每页数量</label>
              <div className="mt-1">
                <Select
                  value={String(limit)}
                  onChange={(value) => setLimit(Number.parseInt(value, 10))}
                  options={[
                    { value: "20", label: "20" },
                    { value: "50", label: "50" },
                    { value: "100", label: "100" },
                    { value: "200", label: "200" },
                  ]}
                />
              </div>
            </div>
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setNotice("");
                  setOpenEditHistoryId(null);
                  setOpenMediaGroupKey(null);
                  syncUrlToCurrentQuery();
                  void fetchMessages({ reset: true });
                }}
                disabled={loading || (!selectedChannelId && !channels.length)}
                className="ui-btn ui-btn-primary h-10"
              >
                {loading ? "查询中..." : "查询"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setNotice("");
                  void copyQueryLink();
                }}
                disabled={loading}
                className="ui-btn ui-btn-secondary h-10"
              >
                复制查询链接
              </button>
              {exportUrl ? (
                <a
                  href={exportUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ui-btn ui-btn-secondary h-10"
                >
                  导出(JSONL)
                </a>
              ) : (
                <span className="inline-flex h-10 items-center justify-center rounded-md border border-black/10 px-4 text-sm text-black/40 dark:border-white/10 dark:text-slate-500">
                  导出(JSONL)
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  const clearedOverrides = {
                    q: "",
                    status: "",
                    messageType: "",
                    hasMediaFilter: "",
                    skipReasonFilter: "",
                    editedFilter: "",
                    deletedFilter: "",
                    minFileSizeMb: "",
                    maxFileSizeMb: "",
                    start: "",
                    end: "",
                    groupMedia: true,
                  } as const;
                  setNotice("");
                  setOpenEditHistoryId(null);
                  setOpenMediaGroupKey(null);
                  syncUrlToCurrentQuery(undefined, clearedOverrides);
                  setQ("");
                  setStatus("");
                  setMessageType("");
                  setHasMediaFilter("");
                  setSkipReasonFilter("");
                  setEditedFilter("");
                  setDeletedFilter("");
                  setMinFileSizeMb("");
                  setMaxFileSizeMb("");
                  setStart("");
                  setEnd("");
                  setGroupMedia(true);
                  setItems([]);
                  setNextCursor(null);
                }}
                disabled={loading}
                className="ui-btn ui-btn-secondary h-10"
              >
                清空条件
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="ui-card">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="ui-section-title">消息列表</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
              {items.length ? `已加载 ${items.length} 条` : "暂无数据（先点击“查询”）"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setNotice("");
              setOpenEditHistoryId(null);
              setOpenMediaGroupKey(null);
              syncUrlToCurrentQuery();
              void fetchMessages({ reset: true });
            }}
            disabled={loading || (!selectedChannelId && !channels.length)}
            className="ui-btn ui-btn-secondary h-10"
          >
            {loading ? "刷新中..." : "刷新"}
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {items.map((m) => {
            const Icon = messageIconMap[m.messageType];
            const historyKey = m.editMappingId ?? m.id;
            const mediaGroupKey = m.mediaGroupId ? `${m.sourceChannelId}:${m.mediaGroupId}` : null;
            const fileSizeText = formatFileSize(m.fileSize);
            const isExpandedText = expandedTextByMessageId[m.id] ?? false;
            const fullText = (m.text ?? "").trim();
            const previewText = (m.textPreview ?? "").trim();
            const shouldShowToggleText = !!fullText && !!previewText && fullText.length > previewText.length;

            const externalLink = m.links.source ?? m.links.mirror;
            const telegramViewLink = m.links.mirror ?? m.links.source;

            const statusBadgeClass = (() => {
              if (m.status === "success") return "ui-badge-success";
              if (m.status === "pending") return "ui-badge-info";
              if (m.status === "failed") return "ui-badge-error";
              if (m.status === "skipped") return "ui-badge-warn";
              return "ui-badge-muted";
            })();

            return (
              <div key={m.id} className="glass-panel rounded-2xl p-5 hover-lift">
                <div className="flex items-start gap-4">
                  <div
                    className={clsx(
                      "w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0",
                      messageColorMap[m.messageType],
                    )}
                  >
                    <Icon className="w-6 h-6" />
                  </div>

                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-gray-600 dark:text-slate-300">
                            <a href={`/channels/${encodeURIComponent(m.sourceChannel.id)}`} className="hover:underline">
                              {m.sourceChannel.name}
                            </a>
                          </p>
                          {!selectedChannelId ? (
                            <button
                              type="button"
                              disabled={loading}
                              onClick={() => {
                                const channelId = m.sourceChannel.id;
                                multiChannelCacheRef.current[buildQuery(null, "")] = { items, nextCursor };
                                const filtered = items.filter((it) => it.sourceChannelId === channelId);
                                const last = filtered[filtered.length - 1];
                                setNotice("");
                                setSelectedChannelId(channelId);
                                setItems(filtered);
                                setNextCursor(
                                  last
                                    ? { sentAt: last.sentAt, sourceChannelId: last.sourceChannelId, sourceMessageId: last.sourceMessageId }
                                    : null,
                                );
                                setOpenEditHistoryId(null);
                                setOpenMediaGroupKey(null);
                                syncUrlToCurrentQuery(channelId);
                              }}
                              className="px-2 py-0.5 bg-white/60 hover:bg-white border border-gray-200 rounded-full text-xs font-medium text-gray-700 transition-all disabled:opacity-50 dark:bg-slate-900/40 dark:hover:bg-white/10 dark:border-white/10 dark:text-slate-200"
                            >
                              只看该频道
                            </button>
                          ) : null}
                          <span className={clsx("ui-badge", statusBadgeClass)}>{labelMessageStatus(m.status)}</span>
                          {isEditedAfterMirror(m) ? <span className="ui-badge ui-badge-success">edited</span> : null}
                          {m.isDeleted ? <span className="ui-badge ui-badge-muted">deleted</span> : null}
                          {m.retryCount > 0 ? <span className="ui-badge ui-badge-muted">retry: {m.retryCount}</span> : null}
                        </div>

                        {m.textPreview || m.text ? (
                          <>
                            <div
                              className={clsx(
                                "text-gray-900 dark:text-slate-100 mt-1 whitespace-pre-wrap",
                                isExpandedText ? "" : "line-clamp-3",
                              )}
                            >
                              {highlightText(isExpandedText ? (m.text ?? m.textPreview ?? "") : (m.textPreview ?? m.text ?? ""), q)}
                            </div>
                            {shouldShowToggleText ? (
                              <button
                                type="button"
                                onClick={() => toggleExpandedText(m.id)}
                                className="mt-1 inline-flex items-center text-xs text-blue-600 hover:text-blue-700 font-medium"
                              >
                                {isExpandedText ? "收起全文" : "展开全文"}
                              </button>
                            ) : null}
                          </>
                        ) : (
                          <p className="text-gray-900 dark:text-slate-100 mt-1">
                            {m.hasMedia
                              ? m.groupSize > 1
                                ? `（媒体组 ${m.groupSize} 条${fileSizeText ? ` · ${fileSizeText}` : ""}）`
                                : `（媒体消息${fileSizeText ? ` · ${fileSizeText}` : ""}）`
                              : "（无文本）"}
                          </p>
                        )}

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {groupMedia && m.groupSize > 1 && mediaGroupKey ? (
                            <button
                              type="button"
                              onClick={() => toggleMediaGroup(m)}
                              className="inline-block px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded-full hover:bg-blue-200 transition-all dark:bg-blue-500/15 dark:text-blue-200 dark:hover:bg-blue-500/25"
                            >
                              {openMediaGroupKey === mediaGroupKey ? "收起相册" : "展开相册"}（{m.groupSize}）
                            </button>
                          ) : null}
                          {fileSizeText ? <span className="ui-badge ui-badge-muted">size: {fileSizeText}</span> : null}
                          {m.skipReason ? (
                            <span className="ui-badge ui-badge-warn">
                              skip: {m.skipReason}（{labelSkipReason(m.skipReason)}）
                            </span>
                          ) : null}
                          {m.errorMessage ? <span className="ui-badge ui-badge-error">错误</span> : null}
                        </div>
                      </div>

                      {externalLink ? (
                        <a
                          href={externalLink}
                          target="_blank"
                          rel="noreferrer"
                          className="p-2 hover:bg-white/60 dark:hover:bg-slate-800/60 rounded-lg transition-all"
                          title="打开链接"
                        >
                          <ExternalLink className="w-5 h-5 text-gray-400 dark:text-slate-400" />
                        </a>
                      ) : (
                        <span className="p-2 rounded-lg opacity-40">
                          <ExternalLink className="w-5 h-5 text-gray-400 dark:text-slate-400" />
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between text-sm text-gray-500 dark:text-slate-400">
                      <span>{formatTime(m.sentAt)}</span>
                      <div className="flex items-center gap-3">
                        {telegramViewLink ? (
                          <a
                            href={telegramViewLink}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 hover:text-blue-700 font-medium"
                          >
                            在 Telegram 中查看
                          </a>
                        ) : (
                          <span className="text-gray-400 dark:text-slate-500 font-medium">在 Telegram 中查看</span>
                        )}
                        {isEditedAfterMirror(m) ? (
                          <button
                            type="button"
                            onClick={() => toggleEditHistory(historyKey, m.editCount)}
                            className="text-blue-600 hover:text-blue-700 font-medium"
                          >
                            {openEditHistoryId === historyKey ? "收起历史" : `编辑历史(${m.editCount})`}
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {m.errorMessage ? <div className="text-xs text-red-700 dark:text-red-200 whitespace-pre-wrap">{m.errorMessage}</div> : null}

                    {groupMedia && m.groupSize > 1 && mediaGroupKey && openMediaGroupKey === mediaGroupKey ? (
                      <div className="mt-3 rounded-2xl border border-gray-200 bg-white/50 p-4 text-xs dark:border-white/10 dark:bg-slate-900/40">
                        {mediaGroupLoadingKey === mediaGroupKey ? (
                          <div className="text-gray-500 dark:text-slate-400">相册加载中...</div>
                        ) : mediaGroupErrorByKey[mediaGroupKey] ? (
                          <div className="text-red-700 dark:text-red-200 whitespace-pre-wrap">{mediaGroupErrorByKey[mediaGroupKey]}</div>
                        ) : mediaGroupItemsByKey[mediaGroupKey]?.length ? (
                          <div className="space-y-2">
                            <div className="text-gray-600 dark:text-slate-300">相册共 {mediaGroupItemsByKey[mediaGroupKey]!.length} 条</div>
                            {mediaGroupItemsByKey[mediaGroupKey]!.map((item, idx) => {
                              const sizeText = formatFileSize(item.fileSize);
                              return (
                                <div key={item.id} className="rounded-xl border border-gray-200 bg-white/60 p-3 dark:border-white/10 dark:bg-slate-900/40">
                                  <div className="text-gray-600 dark:text-slate-300">
                                    #{idx + 1} · id={item.sourceMessageId} · {labelMessageType(item.messageType)} · {labelMessageStatus(item.status)}
                                    {sizeText ? ` · ${sizeText}` : ""}
                                  </div>
                                  {item.skipReason ? (
                                    <div className="mt-1 text-orange-700 dark:text-orange-200">
                                      skip: {item.skipReason}（{labelSkipReason(item.skipReason)}）
                                    </div>
                                  ) : null}
                                  {item.errorMessage ? (
                                    <div className="mt-1 text-red-700 dark:text-red-200 whitespace-pre-wrap">{item.errorMessage}</div>
                                  ) : null}
                                  {item.textPreview ? (
                                    <div className="mt-2 whitespace-pre-wrap">{highlightText(item.textPreview, q)}</div>
                                  ) : null}
                                  <div className="mt-2 flex items-center gap-3">
                                    {item.links.source ? (
                                      <a
                                        href={item.links.source}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-blue-600 hover:text-blue-700 font-medium"
                                      >
                                        原文
                                      </a>
                                    ) : (
                                      <span className="text-gray-400 dark:text-slate-500 font-medium">原文</span>
                                    )}
                                    {item.links.mirror ? (
                                      <a
                                        href={item.links.mirror}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-blue-600 hover:text-blue-700 font-medium"
                                      >
                                        备份
                                      </a>
                                    ) : (
                                      <span className="text-gray-400 dark:text-slate-500 font-medium">备份</span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="text-gray-500 dark:text-slate-400">相册暂无数据</div>
                        )}
                      </div>
                    ) : null}

                    {openEditHistoryId === historyKey ? (
                      <div className="mt-3 rounded-2xl border border-gray-200 bg-white/50 p-4 text-xs dark:border-white/10 dark:bg-slate-900/40">
                        {editHistoryLoadingId === historyKey ? (
                          <div className="text-gray-500 dark:text-slate-400">加载中...</div>
                        ) : editHistoryErrorByMessageId[historyKey] ? (
                          <div className="text-red-700 dark:text-red-200 whitespace-pre-wrap">{editHistoryErrorByMessageId[historyKey]}</div>
                        ) : editHistoryByMessageId[historyKey]?.length ? (
                          <div className="max-h-64 space-y-3 overflow-auto">
                            {(() => {
                              const edits = editHistoryByMessageId[historyKey]!;
                              const ordered = [...edits].sort((a, b) => a.version - b.version);
                              const original = ordered[0]?.previousText ?? null;
                              const versions = [
                                { key: "v0", version: 0, at: m.sentAt, text: original },
                                ...ordered.map((h) => ({ key: h.id, version: h.version, at: h.editedAt, text: h.newText })),
                              ];

                              return (
                                <>
                                  <div className="text-gray-600 dark:text-slate-300">
                                    已记录 {edits.length} 次编辑{edits.length === m.editCount ? "" : `（editCount=${m.editCount}）`}
                                  </div>
                                  {versions.map((v) => (
                                    <div key={v.key} className="rounded-xl border border-gray-200 bg-white/60 p-3 dark:border-white/10 dark:bg-slate-900/40">
                                      <div className="text-gray-600 dark:text-slate-300">
                                        v{v.version} · {formatTime(v.at)}
                                      </div>
                                      <div className="mt-2 whitespace-pre-wrap">
                                        {v.text?.trim() ? highlightText(v.text, q) : "（无文本）"}
                                      </div>
                                    </div>
                                  ))}
                                </>
                              );
                            })()}
                          </div>
                        ) : (
                          <div className="text-gray-500 dark:text-slate-400">暂无编辑历史</div>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4">
          <button
            type="button"
            onClick={() => fetchMessages({ reset: false })}
            disabled={!canLoadMore}
            className="w-full py-3 bg-white/50 hover:bg-white border border-gray-200 rounded-xl font-medium text-gray-700 transition-all disabled:opacity-50 dark:bg-slate-900/40 dark:hover:bg-slate-900/60 dark:border-white/10 dark:text-slate-100"
          >
            {loading ? "加载中..." : nextCursor ? "加载更多" : "没有更多了"}
          </button>
          <div ref={loadMoreSentinelRef} className="h-px w-full" />
        </div>
      </div>
    </div>
  );
}
