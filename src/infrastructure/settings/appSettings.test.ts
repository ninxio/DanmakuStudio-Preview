import { describe, expect, it } from "vitest";
import {
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_APP_SETTINGS,
  clearAppSettings,
  loadAppSettings,
  saveAppSettings,
  type AppSettingsStorage
} from "./appSettings";

describe("应用设置持久化", () => {
  it("没有设置时返回默认值", () => {
    const storage = createMemoryStorage();

    expect(loadAppSettings(storage)).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("只保存非敏感设置并规范化路径前缀", () => {
    const storage = createMemoryStorage();
    const saved = saveAppSettings(
      {
        emby: {
          serverUrl: " https://emby.example.test ",
          pathPrefix: "emby",
          username: " tester "
        },
        alignment: {
          ffmpegPath: " C:\\tools\\ffmpeg.exe ",
          windowMs: 500,
          minGapMs: 0,
          matchThreshold: 0.2
        }
      },
      storage
    );

    expect(saved.emby).toEqual({
      serverUrl: "https://emby.example.test",
      pathPrefix: "/emby",
      username: "tester"
    });
    const raw = storage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "";
    expect(raw).toContain("ffmpeg.exe");
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("token");
    expect(loadAppSettings(storage).alignment.windowMs).toBe(500);
  });

  it("读取旧数据时忽略敏感字段和无效数字", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        emby: {
          serverUrl: "https://emby.example.test",
          pathPrefix: "/emby",
          username: "tester",
          password: "secret"
        },
        alignment: {
          ffmpegPath: "ffmpeg",
          windowMs: -1,
          minGapMs: -10,
          matchThreshold: 0,
          accessToken: "token-1"
        }
      })
    );

    const loaded = loadAppSettings(storage);

    expect(loaded.emby).toEqual({
      serverUrl: "https://emby.example.test",
      pathPrefix: "/emby",
      username: "tester"
    });
    expect(loaded.alignment.windowMs).toBe(DEFAULT_APP_SETTINGS.alignment.windowMs);
    expect(loaded.alignment.minGapMs).toBe(DEFAULT_APP_SETTINGS.alignment.minGapMs);
    expect(loaded.alignment.matchThreshold).toBe(DEFAULT_APP_SETTINGS.alignment.matchThreshold);
    expect(JSON.stringify(loaded)).not.toContain("secret");
    expect(JSON.stringify(loaded)).not.toContain("token-1");
  });

  it("可以清除本地设置", () => {
    const storage = createMemoryStorage();
    saveAppSettings(DEFAULT_APP_SETTINGS, storage);

    clearAppSettings(storage);

    expect(storage.getItem(APP_SETTINGS_STORAGE_KEY)).toBeNull();
  });
});

function createMemoryStorage(): AppSettingsStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    }
  };
}
