import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_SETTINGS_SCHEMA_VERSION, APP_SETTINGS_STORAGE_KEY, loadAppSettings, saveAppSettings } from "./appSettings";
import {
  clearDesktopAppSettings,
  hydrateDesktopAppSettings,
  persistDesktopAppSettings,
  type DesktopAppSettingsBridge
} from "./desktopAppSettings";

describe("桌面应用设置桥", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("从桌面配置读取后会同步到浏览器 fallback 镜像", async () => {
    const bridge: DesktopAppSettingsBridge = {
      load: vi.fn().mockResolvedValue(
        JSON.stringify({
          export: {
            defaultDirectory: "D:\\exports"
          },
          player: {
            mpvPath: "mpv",
            preferredBackend: "nativeMpv"
          },
          emby: {
            serverUrl: "https://emby.example.test",
            pathPrefix: "emby",
            username: "tester",
            password: "secret"
          },
          alignment: {
            ffmpegPath: "ffmpeg",
            windowMs: 500,
            minGapMs: 1200,
            matchThreshold: 0.25
          }
        })
      ),
      save: vi.fn(),
      clear: vi.fn()
    };

    const settings = await hydrateDesktopAppSettings(bridge);

    expect(settings?.emby).toEqual({
      serverUrl: "https://emby.example.test",
      pathPrefix: "/emby",
      username: "tester"
    });
    expect(settings?.export.defaultDirectory).toBe("D:\\exports");
    expect(settings?.player).toEqual({
      mpvPath: "mpv",
      preferredBackend: "nativeMpv"
    });
    expect(loadAppSettings().alignment.windowMs).toBe(500);
    const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "";
    expect(raw).not.toContain("secret");
  });

  it("保存时写入规范化后的桌面配置文件内容", async () => {
    const bridge: DesktopAppSettingsBridge = {
      load: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn()
    };

    await expect(
      persistDesktopAppSettings(
        {
          export: {
            defaultDirectory: " D:\\exports "
          },
          player: {
            mpvPath: " C:\\tools\\mpv.exe ",
            preferredBackend: "nativeMpv"
          },
          emby: {
            serverUrl: " https://emby.example.test ",
            pathPrefix: "emby",
            username: " tester "
          },
          alignment: {
            ffmpegPath: " C:\\tools\\ffmpeg.exe ",
            windowMs: 500,
            minGapMs: 1200,
            matchThreshold: 0.25
          }
        },
        bridge
      )
    ).resolves.toBe(true);

    expect(bridge.save).toHaveBeenCalledTimes(1);
    const [content] = vi.mocked(bridge.save).mock.calls[0];
    expect(JSON.parse(content)).toMatchObject({ schemaVersion: APP_SETTINGS_SCHEMA_VERSION });
    expect(content).toContain("https://emby.example.test");
    expect(content).toContain("D:\\\\exports");
    expect(content).toContain("mpv.exe");
    expect(content).toContain("/emby");
    expect(content).not.toContain("password");
    expect(loadAppSettings().emby.username).toBe("tester");
  });

  it("清除时同时移除桌面配置和浏览器 fallback 镜像", async () => {
    const bridge: DesktopAppSettingsBridge = {
      load: vi.fn(),
      save: vi.fn(),
      clear: vi.fn().mockResolvedValue(undefined)
    };
    saveAppSettings({
      export: {
        defaultDirectory: "D:\\exports"
      },
      player: {
        mpvPath: "mpv",
        preferredBackend: "nativeMpv"
      },
      emby: {
        serverUrl: "https://emby.example.test",
        pathPrefix: "/emby",
        username: "tester"
      },
      alignment: {
        ffmpegPath: "ffmpeg",
        windowMs: 500,
        minGapMs: 1200,
        matchThreshold: 0.25
      }
    });

    await expect(clearDesktopAppSettings(bridge)).resolves.toBe(true);

    expect(bridge.clear).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY)).toBeNull();
  });
});
