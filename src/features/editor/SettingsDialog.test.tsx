import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import {
  APP_SETTINGS_SCHEMA_VERSION,
  APP_SETTINGS_STORAGE_KEY,
  loadAppSettings,
  saveAppSettings
} from "../../infrastructure/settings/appSettings";
import {
  clearVolatileEmbyCredentials,
  loadVolatileEmbyPassword,
  saveVolatileEmbyPassword
} from "../../infrastructure/settings/volatileEmbyCredentials";
import { useEditorStore } from "../../stores/editorStore";
import { SettingsDialog } from "./SettingsDialog";

describe("设置中心", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearVolatileEmbyCredentials();
    useEditorStore.setState({
      project: createEmptyProject(),
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null
    });
  });

  it("保存 Emby 非敏感连接设置，不保存密码或 token", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "Emby 连接" }));
    fireEvent.change(screen.getByLabelText("服务器地址"), {
      target: { value: " https://emby.example.test " }
    });
    fireEvent.change(screen.getByLabelText("路径前缀"), {
      target: { value: "emby" }
    });
    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: " tester " }
    });
    fireEvent.change(screen.getByLabelText("本次会话密码"), {
      target: { value: "secret-pass" }
    });
    await user.click(screen.getByRole("button", { name: /保存设置/ }));

    expect(loadAppSettings().emby).toEqual({
      serverUrl: "https://emby.example.test",
      pathPrefix: "/emby",
      username: "tester"
    });
    expect(loadVolatileEmbyPassword()).toBe("secret-pass");
    const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "";
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("secret-pass");
  });

  it("保存播放器工具和对齐默认参数", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "播放器与工具" }));
    fireEvent.change(screen.getByLabelText("FFmpeg 路径"), {
      target: { value: "C:\\tools\\ffmpeg.exe" }
    });
    fireEvent.change(screen.getByLabelText("mpv 路径"), {
      target: { value: "C:\\tools\\mpv.exe" }
    });
    fireEvent.change(screen.getByLabelText("播放后端"), {
      target: { value: "nativeMpv" }
    });
    fireEvent.change(screen.getByLabelText("窗口 ms"), {
      target: { value: "500" }
    });
    fireEvent.change(screen.getByLabelText("最小缺失 ms"), {
      target: { value: "1200" }
    });
    fireEvent.change(screen.getByLabelText("匹配阈值"), {
      target: { value: "0.22" }
    });
    await user.click(screen.getByRole("button", { name: /保存设置/ }));

    expect(loadAppSettings().alignment).toEqual({
      ffmpegPath: "C:\\tools\\ffmpeg.exe",
      windowMs: 500,
      minGapMs: 1200,
      matchThreshold: 0.22
    });
    expect(loadAppSettings().player).toEqual({
      mpvPath: "C:\\tools\\mpv.exe",
      preferredBackend: "nativeMpv"
    });
  });

  it("保存默认导出目录", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "导出" }));
    fireEvent.change(screen.getByLabelText("默认导出目录"), {
      target: { value: " D:\\danmaku exports " }
    });
    await user.click(screen.getByRole("button", { name: /保存设置/ }));

    expect(loadAppSettings().export.defaultDirectory).toBe("D:\\danmaku exports");
  });

  it("关于页展示当前成熟度提升主线", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "关于" }));

    expect(screen.getByText("成熟度提升主线：播放器工具链、音频对齐与项目安全硬化")).toBeInTheDocument();
  });

  it("可以清除本地应用设置", async () => {
    const user = userEvent.setup();
    saveAppSettings({
      export: {
        defaultDirectory: "D:\\exports"
      },
      player: {
        mpvPath: "C:\\tools\\mpv.exe",
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
        matchThreshold: 0.22
      }
    });
    saveVolatileEmbyPassword("secret-pass");

    render(<SettingsDialog onClose={() => undefined} />);
    await user.click(screen.getByRole("button", { name: /清除本地设置/ }));

    expect(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY)).toBeNull();
    expect(loadVolatileEmbyPassword()).toBe("");
  });

  it("可以导出不包含敏感字段的设置备份", async () => {
    const user = userEvent.setup();
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:settings-backup");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    saveAppSettings({
      export: {
        defaultDirectory: "D:\\exports"
      },
      player: {
        mpvPath: "C:\\tools\\mpv.exe",
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
        matchThreshold: 0.22
      }
    });
    saveVolatileEmbyPassword("secret-pass");

    try {
      render(<SettingsDialog onClose={() => undefined} />);
      await user.click(screen.getByRole("button", { name: "隐私与本地数据" }));
      await user.click(screen.getByRole("button", { name: "导出设置" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const [blob] = createObjectUrl.mock.calls[0];
      if (!(blob instanceof Blob)) {
        throw new Error("导出的设置备份不是 Blob。");
      }
      const text = await readBlobText(blob);
      expect(JSON.parse(text)).toMatchObject({ schemaVersion: APP_SETTINGS_SCHEMA_VERSION });
      expect(text).toContain("https://emby.example.test");
      expect(text).toContain("D:\\\\exports");
      expect(text).toContain("mpv.exe");
      expect(text).not.toContain("secret-pass");
      expect(text).not.toContain("password");
      expect(text).not.toContain("token");
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("设置备份下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("danmaku-settings.json");
      expect(useEditorStore.getState().status.message).toBe("已导出非敏感应用设置备份：danmaku-settings.json。");
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:settings-backup");
    } finally {
      clickSpy.mockRestore();
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (revokeDescriptor) {
        Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });

  it("可以从设置备份导入非敏感配置", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={() => undefined} />);
    const file = new File(
      [
        JSON.stringify({
          emby: {
            serverUrl: " https://backup.example.test ",
            pathPrefix: "emby",
            username: " imported ",
            password: "secret"
          },
          alignment: {
            ffmpegPath: " C:\\tools\\ffmpeg.exe ",
            windowMs: "600",
            minGapMs: "1500",
            matchThreshold: "0.3",
            token: "secret-token"
          },
          export: {
            defaultDirectory: "D:\\imported-exports"
          },
          player: {
            mpvPath: " C:\\tools\\mpv.exe ",
            preferredBackend: "nativeMpv",
            token: "secret-token"
          }
        })
      ],
      "danmaku-settings.json",
      { type: "application/json" }
    );

    await user.upload(screen.getByTestId("settings-import-input"), file);

    await waitFor(() =>
      expect(loadAppSettings()).toMatchObject({
        emby: {
          serverUrl: "https://backup.example.test",
          pathPrefix: "/emby",
          username: "imported"
        },
        alignment: {
          ffmpegPath: "C:\\tools\\ffmpeg.exe",
          windowMs: 600,
          minGapMs: 1500,
          matchThreshold: 0.3
        },
        player: {
          mpvPath: "C:\\tools\\mpv.exe",
          preferredBackend: "nativeMpv"
        },
        export: {
          defaultDirectory: "D:\\imported-exports"
        }
      })
    );
    const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "";
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("token");
  });

  it("导入不支持版本的设置备份会提示错误", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={() => undefined} />);
    const file = new File(
      [
        JSON.stringify({
          schemaVersion: APP_SETTINGS_SCHEMA_VERSION + 1,
          emby: {},
          alignment: {}
        })
      ],
      "future-settings.json",
      { type: "application/json" }
    );

    await user.upload(screen.getByTestId("settings-import-input"), file);

    await waitFor(() => {
      const message = useEditorStore.getState().status.message;
      expect(message).toContain("future-settings.json");
      expect(message).toContain("暂不支持");
    });
  });
});

function readBlobText(blob: Blob): Promise<string> {
  const modernBlob = blob as Blob & { text?: () => Promise<string> };
  if (typeof modernBlob.text === "function") {
    return modernBlob.text();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      if (reader.result instanceof ArrayBuffer) {
        resolve(new TextDecoder().decode(reader.result));
        return;
      }
      resolve("");
    };
    reader.onerror = () => reject(new Error("Blob 读取失败。"));
    reader.readAsText(blob);
  });
}
