import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { APP_SETTINGS_STORAGE_KEY, loadAppSettings, saveAppSettings } from "../../infrastructure/settings/appSettings";
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

  it("保存 FFmpeg 和对齐默认参数", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "FFmpeg 与对齐" }));
    fireEvent.change(screen.getByLabelText("FFmpeg 路径"), {
      target: { value: "C:\\tools\\ffmpeg.exe" }
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
  });

  it("可以清除本地应用设置", async () => {
    const user = userEvent.setup();
    saveAppSettings({
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
});
