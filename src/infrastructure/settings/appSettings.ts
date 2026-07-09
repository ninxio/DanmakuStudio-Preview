export interface AppSettings {
  emby: {
    serverUrl: string;
    pathPrefix: string;
    username: string;
  };
  alignment: {
    ffmpegPath: string;
    windowMs: number;
    minGapMs: number;
    matchThreshold: number;
  };
}

export interface AppSettingsStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export const APP_SETTINGS_STORAGE_KEY = "danmaku.timelineStudio.appSettings.v1";

export const DEFAULT_APP_SETTINGS: AppSettings = {
  emby: {
    serverUrl: "",
    pathPrefix: "/emby",
    username: ""
  },
  alignment: {
    ffmpegPath: "",
    windowMs: 1000,
    minGapMs: 3000,
    matchThreshold: 0.35
  }
};

export function loadAppSettings(storage = getDefaultStorage()): AppSettings {
  if (!storage) {
    return cloneAppSettings(DEFAULT_APP_SETTINGS);
  }
  const raw = storage.getItem(APP_SETTINGS_STORAGE_KEY);
  if (!raw) {
    return cloneAppSettings(DEFAULT_APP_SETTINGS);
  }
  return parseAppSettingsText(raw);
}

export function saveAppSettings(settings: AppSettings, storage = getDefaultStorage()): AppSettings {
  const normalized = normalizeAppSettings(settings);
  if (storage) {
    storage.setItem(APP_SETTINGS_STORAGE_KEY, serializeAppSettings(normalized));
  }
  return normalized;
}

export function clearAppSettings(storage = getDefaultStorage()): void {
  storage?.removeItem(APP_SETTINGS_STORAGE_KEY);
}

export function cloneAppSettings(settings: AppSettings): AppSettings {
  return {
    emby: { ...settings.emby },
    alignment: { ...settings.alignment }
  };
}

export function parseAppSettingsText(text: string): AppSettings {
  try {
    return parseAppSettingsTextStrict(text);
  } catch {
    return cloneAppSettings(DEFAULT_APP_SETTINGS);
  }
}

export function parseAppSettingsTextStrict(text: string): AppSettings {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("设置备份必须是 JSON 对象。");
  }
  return normalizeAppSettings(parsed);
}

export function serializeAppSettings(settings: AppSettings): string {
  return JSON.stringify(normalizeAppSettings(settings));
}

export function normalizeAppSettings(value: unknown): AppSettings {
  if (!isRecord(value)) {
    return cloneAppSettings(DEFAULT_APP_SETTINGS);
  }
  const emby = isRecord(value.emby) ? value.emby : {};
  const alignment = isRecord(value.alignment) ? value.alignment : {};
  return {
    emby: {
      serverUrl: readString(emby.serverUrl, DEFAULT_APP_SETTINGS.emby.serverUrl),
      pathPrefix: normalizePathPrefix(readString(emby.pathPrefix, DEFAULT_APP_SETTINGS.emby.pathPrefix)),
      username: readString(emby.username, DEFAULT_APP_SETTINGS.emby.username)
    },
    alignment: {
      ffmpegPath: readString(alignment.ffmpegPath, DEFAULT_APP_SETTINGS.alignment.ffmpegPath),
      windowMs: readPositiveInteger(alignment.windowMs, DEFAULT_APP_SETTINGS.alignment.windowMs),
      minGapMs: readNonNegativeInteger(alignment.minGapMs, DEFAULT_APP_SETTINGS.alignment.minGapMs),
      matchThreshold: readPositiveNumber(alignment.matchThreshold, DEFAULT_APP_SETTINGS.alignment.matchThreshold)
    }
  };
}

function getDefaultStorage(): AppSettingsStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizePathPrefix(value: string): string {
  if (value.trim().length === 0) {
    return "";
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function readPositiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
