import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  clearAppSettings,
  parseAppSettingsText,
  saveAppSettings,
  serializeAppSettings,
  type AppSettings
} from "./appSettings";

export interface DesktopAppSettingsBridge {
  load: () => Promise<string | null>;
  save: (content: string) => Promise<void>;
  clear: () => Promise<void>;
}

const defaultDesktopAppSettingsBridge: DesktopAppSettingsBridge = {
  load: () => invoke<string | null>("load_app_settings_file"),
  save: (content) => invoke<void>("save_app_settings_file", { content }),
  clear: () => invoke<void>("clear_app_settings_file")
};

export async function hydrateDesktopAppSettings(
  bridge: DesktopAppSettingsBridge = defaultDesktopAppSettingsBridge
): Promise<AppSettings | null> {
  if (bridge === defaultDesktopAppSettingsBridge && !isTauri()) {
    return null;
  }
  const content = await bridge.load();
  if (!content) {
    return null;
  }
  const settings = parseAppSettingsText(content);
  saveAppSettings(settings);
  return settings;
}

export async function persistDesktopAppSettings(
  settings: AppSettings,
  bridge: DesktopAppSettingsBridge = defaultDesktopAppSettingsBridge
): Promise<boolean> {
  const normalized = saveAppSettings(settings);
  if (bridge === defaultDesktopAppSettingsBridge && !isTauri()) {
    return false;
  }
  await bridge.save(serializeAppSettings(normalized));
  return true;
}

export async function clearDesktopAppSettings(
  bridge: DesktopAppSettingsBridge = defaultDesktopAppSettingsBridge
): Promise<boolean> {
  clearAppSettings();
  if (bridge === defaultDesktopAppSettingsBridge && !isTauri()) {
    return false;
  }
  await bridge.clear();
  return true;
}

export function formatDesktopSettingsError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
