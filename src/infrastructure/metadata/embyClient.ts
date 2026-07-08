import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Milliseconds } from "../../domain/shared/time";

export interface EmbyAuthSession {
  userId: string;
  accessToken: string;
  userName: string;
}

export interface EmbyItemMetadata {
  id: string;
  name: string;
  type: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  durationMs: Milliseconds | null;
}

export interface EmbySearchOptions {
  searchTerm: string;
  includeItemTypes?: string[];
  limit?: number;
}

interface ParsedEmbySearchText {
  keyword: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

export interface EmbyClientConfig {
  serverUrl: string;
  pathPrefix: string;
}

export interface EmbyCredentials {
  username: string;
  password: string;
}

interface EmbyUserDto {
  Id?: unknown;
  Name?: unknown;
}

interface EmbyAuthDto {
  User?: EmbyUserDto;
  AccessToken?: unknown;
}

interface EmbyMediaSourceDto {
  RunTimeTicks?: unknown;
}

interface EmbyItemDto {
  Id?: unknown;
  Name?: unknown;
  Type?: unknown;
  RunTimeTicks?: unknown;
  ParentIndexNumber?: unknown;
  IndexNumber?: unknown;
  MediaSources?: unknown;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type EmbyFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<FetchResponse>;

type EmbyProxyMethod = "GET" | "POST";

interface EmbyProxyHeader {
  name: string;
  value: string;
}

export interface EmbyProxyRequest {
  url: string;
  method: EmbyProxyMethod;
  headers: EmbyProxyHeader[];
  body: string | null;
}

export interface EmbyProxyResponse {
  status: number;
  body: unknown;
}

export type EmbyProxyInvoker = (request: EmbyProxyRequest) => Promise<EmbyProxyResponse>;

const CLIENT_NAME = "Danmaku Timeline Studio";
const CLIENT_VERSION = "0.1.0";
const TAURI_EMBY_FETCH = createTauriEmbyFetch((request) =>
  invoke<EmbyProxyResponse>("emby_http_request", { request })
);

export async function authenticateEmby(
  config: EmbyClientConfig,
  credentials: EmbyCredentials,
  fetcher: EmbyFetch = getDefaultEmbyFetch()
): Promise<EmbyAuthSession> {
  const response = await fetchEmbyRequest(fetcher, createEmbyUrl(config, "/Users/AuthenticateByName"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Emby-Authorization": createAuthorizationHeader()
    },
    body: JSON.stringify({
      Username: credentials.username,
      Pw: credentials.password
    })
  });
  const payload = await parseEmbyResponse(response, "Emby 登录失败");
  const auth = parseAuthPayload(payload);
  if (!auth) {
    throw new Error("Emby 登录响应缺少 User.Id 或 AccessToken。");
  }
  return auth;
}

export async function fetchEmbyItem(
  config: EmbyClientConfig,
  session: EmbyAuthSession,
  itemId: string,
  fetcher: EmbyFetch = getDefaultEmbyFetch()
): Promise<EmbyItemMetadata> {
  const url = createEmbyUrl(config, `/Users/${encodeURIComponent(session.userId)}/Items/${encodeURIComponent(itemId)}`);
  url.searchParams.set("Fields", "MediaSources,Path,ProviderIds,RunTimeTicks,ParentIndexNumber,IndexNumber");
  const response = await fetchEmbyRequest(fetcher, url, {
    headers: createTokenHeaders(session.accessToken)
  });
  const payload = await parseEmbyResponse(response, "读取 Emby 条目失败");
  const item = parseItemPayload(payload);
  if (!item) {
    throw new Error("Emby 条目响应格式不可识别。");
  }
  return item;
}

export async function fetchEmbyEpisodeChildren(
  config: EmbyClientConfig,
  session: EmbyAuthSession,
  parentItemId: string,
  fetcher: EmbyFetch = getDefaultEmbyFetch()
): Promise<EmbyItemMetadata[]> {
  const url = createEmbyUrl(config, `/Users/${encodeURIComponent(session.userId)}/Items`);
  url.searchParams.set("ParentId", parentItemId);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", "Episode");
  url.searchParams.set("Fields", "MediaSources,Path,ProviderIds,RunTimeTicks,ParentIndexNumber,IndexNumber");
  url.searchParams.set("SortBy", "ParentIndexNumber,IndexNumber,SortName");
  url.searchParams.set("SortOrder", "Ascending");
  const response = await fetchEmbyRequest(fetcher, url, {
    headers: createTokenHeaders(session.accessToken)
  });
  const payload = await parseEmbyResponse(response, "读取 Emby 剧集列表失败");
  if (!isRecord(payload) || !Array.isArray(payload.Items)) {
    throw new Error("Emby 剧集列表响应格式不可识别。");
  }
  return payload.Items.flatMap((item) => {
    const parsed = parseItemPayload(item);
    return parsed ? [parsed] : [];
  });
}

export async function searchEmbyItems(
  config: EmbyClientConfig,
  session: EmbyAuthSession,
  options: EmbySearchOptions,
  fetcher: EmbyFetch = getDefaultEmbyFetch()
): Promise<EmbyItemMetadata[]> {
  const query = parseEmbySearchText(options.searchTerm);
  const searchTerm = query.keyword.length > 0 ? query.keyword : options.searchTerm.trim();
  if (searchTerm.length === 0) {
    return [];
  }
  const url = createEmbyUrl(config, `/Users/${encodeURIComponent(session.userId)}/Items`);
  url.searchParams.set("SearchTerm", searchTerm);
  url.searchParams.set("Recursive", "true");
  url.searchParams.set("IncludeItemTypes", (options.includeItemTypes ?? ["Movie", "Series", "Season", "Episode"]).join(","));
  url.searchParams.set("Fields", "MediaSources,Path,ProviderIds,RunTimeTicks,ParentIndexNumber,IndexNumber");
  url.searchParams.set("SortBy", "SortName");
  url.searchParams.set("SortOrder", "Ascending");
  url.searchParams.set("Limit", Math.max(1, Math.min(options.limit ?? 20, 50)).toString());
  const response = await fetchEmbyRequest(fetcher, url, {
    headers: createTokenHeaders(session.accessToken)
  });
  const payload = await parseEmbyResponse(response, "搜索 Emby 条目失败");
  if (!isRecord(payload) || !Array.isArray(payload.Items)) {
    throw new Error("Emby 搜索响应格式不可识别。");
  }
  const items = payload.Items.flatMap((item) => {
    const parsed = parseItemPayload(item);
    return parsed ? [parsed] : [];
  });
  return rankEmbySearchResults(items, query);
}

export function formatEmbyEpisodeDurationLines(items: EmbyItemMetadata[]): string {
  return items
    .filter((item) => item.durationMs !== null)
    .sort(
      (left, right) =>
        (left.seasonNumber ?? 0) - (right.seasonNumber ?? 0) ||
        (left.episodeNumber ?? 0) - (right.episodeNumber ?? 0) ||
        left.name.localeCompare(right.name, "zh-CN")
    )
    .map((item, index) => {
      const season = item.seasonNumber ?? 1;
      const episode = item.episodeNumber ?? index + 1;
      return `S${season.toString().padStart(2, "0")}E${episode.toString().padStart(2, "0")} ${formatDuration(item.durationMs ?? 0)}`;
    })
    .join("\n");
}

export function formatEmbySingleDurationLine(item: EmbyItemMetadata): string {
  if (item.durationMs === null) {
    return "";
  }
  const season = item.seasonNumber ?? 1;
  const episode = item.episodeNumber ?? 1;
  return `S${season.toString().padStart(2, "0")}E${episode.toString().padStart(2, "0")} ${formatDuration(item.durationMs)}`;
}

export function createTauriEmbyFetch(proxyInvoker: EmbyProxyInvoker): EmbyFetch {
  return async (input, init) => {
    const response = await proxyInvoker(createEmbyProxyRequest(input, init));
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: () => Promise.resolve(response.body)
    };
  };
}

function getDefaultEmbyFetch(): EmbyFetch {
  return isTauri() ? TAURI_EMBY_FETCH : fetch;
}

function createEmbyProxyRequest(input: RequestInfo | URL, init?: RequestInit): EmbyProxyRequest {
  return {
    url: requestInputToUrl(input),
    method: requestMethod(input, init),
    headers: requestHeaders(input, init),
    body: requestBody(init)
  };
}

function requestInputToUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): EmbyProxyMethod {
  const requestDefault = typeof Request !== "undefined" && input instanceof Request ? input.method : "GET";
  const normalized = (init?.method ?? requestDefault).toUpperCase();
  if (normalized === "GET" || normalized === "POST") {
    return normalized;
  }
  throw new Error("Emby 桌面代理仅支持 GET 和 POST 请求。");
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): EmbyProxyHeader[] {
  const headers = new Headers();
  if (typeof Request !== "undefined" && input instanceof Request) {
    input.headers.forEach((value, name) => headers.set(name, value));
  }
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  return Array.from(headers.entries()).map(([name, value]) => ({ name, value }));
}

function requestBody(init?: RequestInit): string | null {
  const body = init?.body;
  if (body === undefined || body === null) {
    return null;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  throw new Error("Emby 桌面代理目前仅支持文本请求体。");
}

function createEmbyUrl(config: EmbyClientConfig, path: string): URL {
  const baseUrl = normalizeBaseUrl(config.serverUrl, config.pathPrefix);
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  return new URL(cleanPath, `${baseUrl}/`);
}

function normalizeBaseUrl(serverUrl: string, pathPrefix: string): string {
  const url = new URL(serverUrl);
  const cleanPrefix = pathPrefix.trim().replace(/^\/+|\/+$/g, "");
  const pathParts = [url.pathname.replace(/^\/+|\/+$/g, ""), cleanPrefix].filter((part) => part.length > 0);
  url.pathname = pathParts.length > 0 ? `/${pathParts.join("/")}` : "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function createAuthorizationHeader(): string {
  const values = [
    `MediaBrowser Client="${CLIENT_NAME}"`,
    `Device="Browser"`,
    `DeviceId="danmaku-timeline-studio-browser"`,
    `Version="${CLIENT_VERSION}"`
  ];
  return values.join(", ");
}

function createTokenHeaders(accessToken: string): HeadersInit {
  return {
    "X-Emby-Token": accessToken,
    "X-Emby-Authorization": createAuthorizationHeader()
  };
}

function parseEmbySearchText(text: string): ParsedEmbySearchText {
  const raw = text.trim();
  const result: ParsedEmbySearchText = {
    keyword: raw,
    seasonNumber: null,
    episodeNumber: null
  };
  const seasonEpisodePatterns = [
    /S(\d{1,2})\s*E(\d{1,3})/i,
    /第\s*(\d{1,2})\s*季\s*第?\s*(\d{1,3})\s*(?:集|话|話)?/,
    /(\d{1,2})\s*[xX]\s*(\d{1,3})/
  ];
  for (const pattern of seasonEpisodePatterns) {
    const match = raw.match(pattern);
    if (match) {
      result.seasonNumber = Number(match[1]);
      result.episodeNumber = Number(match[2]);
      result.keyword = raw.replace(match[0], " ");
      return cleanParsedSearchText(result);
    }
  }
  const episodeOnly = raw.match(/(?:E|第)\s*(\d{1,3})\s*(?:集|话|話)?/i);
  if (episodeOnly) {
    result.episodeNumber = Number(episodeOnly[1]);
    result.keyword = raw.replace(episodeOnly[0], " ");
  }
  return cleanParsedSearchText(result);
}

function cleanParsedSearchText(query: ParsedEmbySearchText): ParsedEmbySearchText {
  return {
    ...query,
    keyword: query.keyword.replace(/[,:：，;；_-]+$/g, "").replace(/\s+/g, " ").trim()
  };
}

function rankEmbySearchResults(items: EmbyItemMetadata[], query: ParsedEmbySearchText): EmbyItemMetadata[] {
  return [...items].sort((left, right) => {
    const scoreDelta = scoreEmbySearchItem(right, query) - scoreEmbySearchItem(left, query);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return (
      (left.seasonNumber ?? 0) - (right.seasonNumber ?? 0) ||
      (left.episodeNumber ?? 0) - (right.episodeNumber ?? 0) ||
      left.name.localeCompare(right.name, "zh-CN")
    );
  });
}

function scoreEmbySearchItem(item: EmbyItemMetadata, query: ParsedEmbySearchText): number {
  let score = 0;
  const keyword = normalizeSearchText(query.keyword);
  const name = normalizeSearchText(item.name);
  if (keyword.length > 0 && name.length > 0) {
    if (name === keyword) {
      score += 80;
    } else if (name.includes(keyword)) {
      score += 40;
    } else if (keyword.includes(name)) {
      score += 20;
    }
  }
  if (query.seasonNumber !== null) {
    score += item.seasonNumber === query.seasonNumber ? 30 : item.seasonNumber === null ? 0 : -10;
  }
  if (query.episodeNumber !== null) {
    score += item.episodeNumber === query.episodeNumber ? 45 : item.episodeNumber === null ? 0 : -10;
    score += item.type === "Episode" ? 10 : 0;
  }
  if (item.durationMs !== null) {
    score += 2;
  }
  return score;
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
}

async function fetchEmbyRequest(fetcher: EmbyFetch, input: RequestInfo | URL, init?: RequestInit): Promise<FetchResponse> {
  try {
    return await fetcher(input, init);
  } catch (error) {
    const detail = error instanceof Error && error.message.length > 0 ? `原始错误：${error.message}` : "没有返回 HTTP 响应。";
    throw new Error(
      `Emby 请求未能发出。请检查服务器地址、路径前缀、HTTPS 证书和网络连通性；网页模式下还可能是订阅服务未开放 CORS，桌面模式会自动使用 Tauri 代理。${detail}`
    );
  }
}

async function parseEmbyResponse(response: FetchResponse, fallbackMessage: string): Promise<unknown> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = readErrorMessage(payload) ?? `${fallbackMessage}：HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function parseAuthPayload(payload: unknown): EmbyAuthSession | null {
  if (!isRecord(payload)) {
    return null;
  }
  const dto = payload as EmbyAuthDto;
  if (!isRecord(dto.User) || typeof dto.User.Id !== "string" || typeof dto.AccessToken !== "string") {
    return null;
  }
  return {
    userId: dto.User.Id,
    accessToken: dto.AccessToken,
    userName: typeof dto.User.Name === "string" ? dto.User.Name : ""
  };
}

function parseItemPayload(payload: unknown): EmbyItemMetadata | null {
  if (!isRecord(payload)) {
    return null;
  }
  const dto = payload as EmbyItemDto;
  if (typeof dto.Id !== "string" || typeof dto.Name !== "string") {
    return null;
  }
  return {
    id: dto.Id,
    name: dto.Name,
    type: typeof dto.Type === "string" ? dto.Type : "Unknown",
    seasonNumber: toIntegerOrNull(dto.ParentIndexNumber),
    episodeNumber: toIntegerOrNull(dto.IndexNumber),
    durationMs: readDurationMs(dto)
  };
}

function readDurationMs(item: EmbyItemDto): Milliseconds | null {
  const direct = ticksToMilliseconds(item.RunTimeTicks);
  if (direct !== null) {
    return direct;
  }
  if (!Array.isArray(item.MediaSources)) {
    return null;
  }
  for (const mediaSource of item.MediaSources) {
    if (!isRecord(mediaSource)) {
      continue;
    }
    const ticks = ticksToMilliseconds((mediaSource as EmbyMediaSourceDto).RunTimeTicks);
    if (ticks !== null) {
      return ticks;
    }
  }
  return null;
}

function ticksToMilliseconds(value: unknown): Milliseconds | null {
  const ticks = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(ticks) || ticks <= 0) {
    return null;
  }
  return Math.round(ticks / 10_000);
}

function toIntegerOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

function formatDuration(milliseconds: Milliseconds): string {
  const ms = Math.max(0, Math.round(milliseconds));
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const fraction = ms % 1000;
  const base =
    hours > 0
      ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
      : `${minutes}:${seconds.toString().padStart(2, "0")}`;
  return fraction > 0 ? `${base}.${fraction.toString().padStart(3, "0")}` : base;
}

function readErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const message = payload.Message ?? payload.message ?? payload.Error ?? payload.error;
  return typeof message === "string" && message.length > 0 ? message : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
