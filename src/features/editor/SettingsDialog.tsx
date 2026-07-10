import {
  Download,
  FolderOpen,
  Info,
  MonitorCog,
  Save,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Field } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import { TextButton } from "../../components/TextButton";
import {
  DEFAULT_APP_SETTINGS,
  clearAppSettings,
  cloneAppSettings,
  loadAppSettings,
  parseAppSettingsTextStrict,
  saveAppSettings,
  serializeAppSettings,
  type AppSettings
} from "../../infrastructure/settings/appSettings";
import { downloadTextFile, readTextFile } from "../../infrastructure/file-system/browserFiles";
import { formatExportFileError } from "../../infrastructure/file-system/exportFiles";
import { pickExportDirectoryPath } from "../../infrastructure/file-system/nativeDialogs";
import {
  clearDesktopAppSettings,
  formatDesktopSettingsError,
  hydrateDesktopAppSettings,
  persistDesktopAppSettings
} from "../../infrastructure/settings/desktopAppSettings";
import {
  clearVolatileEmbyCredentials,
  loadVolatileEmbyPassword,
  saveVolatileEmbyPassword
} from "../../infrastructure/settings/volatileEmbyCredentials";
import { useEditorStore } from "../../stores/editorStore";

interface SettingsDialogProps {
  onClose: () => void;
}

type SettingsTab = "general" | "export" | "emby" | "alignment" | "privacy" | "about";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; icon: typeof MonitorCog }> = [
  { id: "general", label: "常规", icon: MonitorCog },
  { id: "export", label: "导出", icon: FolderOpen },
  { id: "emby", label: "Emby 连接", icon: Server },
  { id: "alignment", label: "FFmpeg 与对齐", icon: SlidersHorizontal },
  { id: "privacy", label: "隐私与本地数据", icon: ShieldCheck },
  { id: "about", label: "关于", icon: Info }
];

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [settings, setSettings] = useState<AppSettings>(() => loadAppSettings());
  const [embyPassword, setEmbyPassword] = useState(() => loadVolatileEmbyPassword());
  const settingsInputRef = useRef<HTMLInputElement | null>(null);
  const project = useEditorStore((state) => state.project);
  const setGlobalOffset = useEditorStore((state) => state.setGlobalOffset);
  const updatePreview = useEditorStore((state) => state.updatePreview);

  useEffect(() => {
    let mounted = true;
    void hydrateDesktopAppSettings()
      .then((desktopSettings) => {
        if (mounted && desktopSettings) {
          setSettings(desktopSettings);
        }
      })
      .catch((error) => {
        if (mounted) {
          setStatus(`读取桌面应用设置失败，已使用浏览器本地设置：${formatDesktopSettingsError(error)}`, "warning");
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  const saveSettings = () => {
    const saved = saveAppSettings(settings);
    saveVolatileEmbyPassword(embyPassword);
    setSettings(saved);
    void persistDesktopAppSettings(saved)
      .then((storedInDesktop) => {
        setStatus(
          storedInDesktop
            ? "应用设置已保存到桌面配置目录；Emby 密码仅保存在本次应用会话。"
            : "应用设置已保存到浏览器本地存储；Emby 密码仅保存在本次应用会话。",
          "success"
        );
      })
      .catch((error) => {
        setStatus(`桌面应用设置保存失败，已保留浏览器本地副本：${formatDesktopSettingsError(error)}`, "warning");
      });
  };

  const exportSettingsBackup = () => {
    const fileName = downloadTextFile(
      "danmaku-settings.json",
      `${serializeAppSettings(settings)}\n`,
      "application/json;charset=utf-8"
    );
    setStatus(`已导出非敏感应用设置备份：${fileName}。`, "success");
  };

  const importSettingsBackup = async (file: File) => {
    try {
      const imported = parseAppSettingsTextStrict(await readTextFile(file));
      const saved = saveAppSettings(imported);
      setSettings(saved);
      void persistDesktopAppSettings(saved)
        .then((storedInDesktop) => {
          setStatus(storedInDesktop ? "已导入设置并保存到桌面配置目录。" : "已导入设置并保存到浏览器本地存储。", "success");
        })
        .catch((error) => {
          setStatus(`设置已导入到浏览器本地副本，但写入桌面配置失败：${formatDesktopSettingsError(error)}`, "warning");
        });
    } catch (error) {
      setStatus(formatSettingsImportError(file, error), "error");
    }
  };

  const restoreDefaults = () => {
    const next = cloneAppSettings(DEFAULT_APP_SETTINGS);
    const saved = saveAppSettings(next);
    clearVolatileEmbyCredentials();
    setSettings(saved);
    setEmbyPassword("");
    void persistDesktopAppSettings(saved)
      .then((storedInDesktop) => {
        setStatus(storedInDesktop ? "已恢复默认桌面应用设置。" : "已恢复默认浏览器本地设置。", "success");
      })
      .catch((error) => {
        setStatus(`恢复默认设置时写入桌面配置失败：${formatDesktopSettingsError(error)}`, "warning");
      });
  };

  const clearLocalSettings = () => {
    clearAppSettings();
    clearVolatileEmbyCredentials();
    setSettings(cloneAppSettings(DEFAULT_APP_SETTINGS));
    setEmbyPassword("");
    void clearDesktopAppSettings()
      .then((clearedDesktop) => {
        setStatus(clearedDesktop ? "已清除桌面应用设置和本次会话密码。" : "已清除浏览器本地设置和本次会话密码。", "success");
      })
      .catch((error) => {
        setStatus(`清除桌面应用设置失败，浏览器本地副本已清除：${formatDesktopSettingsError(error)}`, "warning");
      });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="grid h-[min(720px,calc(100vh-32px))] w-[min(860px,calc(100vw-32px))] grid-rows-[48px_minmax(0,1fr)_56px] overflow-hidden rounded border border-panel-line bg-panel-raised shadow-2xl">
        <header className="flex items-center justify-between border-b border-panel-line px-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">设置中心</h2>
            <p className="text-[11px] text-slate-500">产品成熟度提升版</p>
          </div>
          <IconButton label="关闭设置" icon={<X size={16} />} onClick={onClose} />
        </header>
        <div className="grid min-h-0 grid-cols-[190px_minmax(0,1fr)]">
          <nav className="border-r border-panel-line bg-[#111318] p-2" aria-label="设置分类">
            {SETTINGS_TABS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={tab === item.id}
                  className={`mb-1 flex h-9 w-full items-center gap-2 rounded px-2 text-left text-xs transition ${
                    tab === item.id
                      ? "bg-accent-cyan/15 text-accent-cyan"
                      : "text-slate-400 hover:bg-panel-soft hover:text-slate-100"
                  }`}
                  onClick={() => setTab(item.id)}
                >
                  <Icon size={15} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <main className="thin-scrollbar min-h-0 overflow-auto p-5">
            {tab === "general" ? (
              <GeneralSettingsPanel
                projectOffsetMs={project.globalOffsetMs}
                danmakuVisible={project.preview.danmakuVisible}
                safeAreaVisible={project.preview.safeAreaVisible}
                opacity={project.preview.opacity}
                onOffsetChange={setGlobalOffset}
                onPreviewChange={updatePreview}
              />
            ) : null}
            {tab === "export" ? <ExportSettingsPanel settings={settings} onChange={setSettings} /> : null}
            {tab === "emby" ? (
              <EmbySettingsPanel
                settings={settings}
                password={embyPassword}
                onChange={setSettings}
                onPasswordChange={setEmbyPassword}
              />
            ) : null}
            {tab === "alignment" ? (
              <AlignmentSettingsPanel settings={settings} onChange={setSettings} />
            ) : null}
            {tab === "privacy" ? (
              <PrivacySettingsPanel
                onExportSettings={exportSettingsBackup}
                onImportSettings={() => settingsInputRef.current?.click()}
              />
            ) : null}
            {tab === "about" ? <AboutSettingsPanel /> : null}
          </main>
        </div>
        <footer className="flex items-center justify-between border-t border-panel-line px-4">
          <TextButton tone="danger" onClick={clearLocalSettings}>
            <Trash2 size={14} />
            清除本地设置
          </TextButton>
          <div className="flex gap-2">
            <TextButton onClick={restoreDefaults}>恢复默认</TextButton>
            <TextButton tone="primary" onClick={saveSettings}>
              <Save size={14} />
              保存设置
            </TextButton>
            <TextButton onClick={onClose}>完成</TextButton>
          </div>
        </footer>
        <input
          ref={settingsInputRef}
          className="hidden"
          type="file"
          accept=".json,application/json"
          aria-label="导入设置文件"
          data-testid="settings-import-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void importSettingsBackup(file);
            }
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

function GeneralSettingsPanel({
  projectOffsetMs,
  danmakuVisible,
  safeAreaVisible,
  opacity,
  onOffsetChange,
  onPreviewChange
}: {
  projectOffsetMs: number;
  danmakuVisible: boolean;
  safeAreaVisible: boolean;
  opacity: number;
  onOffsetChange: (value: number) => void;
  onPreviewChange: (patch: { danmakuVisible?: boolean; safeAreaVisible?: boolean; opacity?: number }) => void;
}) {
  return (
    <SettingsSection title="常规" description="保留和时间轴工作区直接相关的项目级设置。">
      <Field
        label="全局偏移"
        type="number"
        value={projectOffsetMs}
        suffix="ms"
        onChange={(event) => onOffsetChange(Number(event.target.value))}
      />
      <ToggleRow
        label="弹幕叠加"
        checked={danmakuVisible}
        onChange={(checked) => onPreviewChange({ danmakuVisible: checked })}
      />
      <ToggleRow
        label="显示安全区"
        checked={safeAreaVisible}
        onChange={(checked) => onPreviewChange({ safeAreaVisible: checked })}
      />
      <label className="grid gap-2 text-xs text-slate-300">
        预览弹幕透明度
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={opacity}
          className="accent-accent-cyan"
          onChange={(event) => onPreviewChange({ opacity: Number(event.target.value) })}
        />
      </label>
    </SettingsSection>
  );
}

function ExportSettingsPanel({
  settings,
  onChange
}: {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}) {
  const chooseDirectory = async () => {
    try {
      const path = await pickExportDirectoryPath(settings.export.defaultDirectory);
      if (!path) {
        return;
      }
      onChange({
        ...settings,
        export: { ...settings.export, defaultDirectory: path }
      });
      setStatus("已选择默认导出文件夹，保存设置后生效。", "success");
    } catch (error) {
      setStatus(`选择导出文件夹失败：${formatExportFileError(error)}`, "warning");
    }
  };

  return (
    <SettingsSection title="导出" description="设置单集 XML、分集 ZIP 和导出报告的默认去向。">
      <Field
        label="默认导出目录"
        value={settings.export.defaultDirectory}
        placeholder="留空时使用浏览器下载"
        onChange={(event) =>
          onChange({
            ...settings,
            export: { ...settings.export, defaultDirectory: event.target.value }
          })
        }
      />
      <div className="flex flex-wrap gap-2">
        <TextButton onClick={() => void chooseDirectory()}>
          <FolderOpen size={14} />
          选择目录
        </TextButton>
        <TextButton
          onClick={() =>
            onChange({
              ...settings,
              export: { ...settings.export, defaultDirectory: "" }
            })
          }
        >
          改用下载
        </TextButton>
      </div>
      <InfoBox>
        默认目录只保存在本机应用设置里；导出的 XML、ZIP 和报告不会额外写入你的本地路径。目录不存在或没有写入权限时，导出时会直接提示你重新选择。
      </InfoBox>
    </SettingsSection>
  );
}

function EmbySettingsPanel({
  settings,
  password,
  onChange,
  onPasswordChange
}: {
  settings: AppSettings;
  password: string;
  onChange: (settings: AppSettings) => void;
  onPasswordChange: (password: string) => void;
}) {
  return (
    <SettingsSection title="Emby 连接" description="服务器、路径和用户名会保存到桌面配置文件；网页模式使用浏览器本地存储。密码只保存在本次应用会话。">
      <Field
        label="服务器地址"
        value={settings.emby.serverUrl}
        placeholder="https://example.com:443"
        onChange={(event) =>
          onChange({
            ...settings,
            emby: { ...settings.emby, serverUrl: event.target.value }
          })
        }
      />
      <Field
        label="路径前缀"
        value={settings.emby.pathPrefix}
        placeholder="/emby"
        onChange={(event) =>
          onChange({
            ...settings,
            emby: { ...settings.emby, pathPrefix: event.target.value }
          })
        }
      />
      <Field
        label="用户名"
        value={settings.emby.username}
        autoComplete="username"
        onChange={(event) =>
          onChange({
            ...settings,
            emby: { ...settings.emby, username: event.target.value }
          })
        }
      />
      <Field
        label="本次会话密码"
        type="password"
        value={password}
        placeholder="关闭应用后自动失效"
        autoComplete="current-password"
        onChange={(event) => onPasswordChange(event.target.value)}
      />
      <InfoBox>
        主界面的 Emby 时长面板会直接读取这里的连接配置进行搜索。当前实验版不会把 Emby 密码或 token 写入项目文件、桌面配置文件、localStorage 或明文设置；后续接入 Windows 凭据管理器后再提供跨次启动记忆。
      </InfoBox>
    </SettingsSection>
  );
}

function AlignmentSettingsPanel({
  settings,
  onChange
}: {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}) {
  return (
    <SettingsSection title="FFmpeg 与对齐" description="为视频对齐实验室提供默认值，仍可在运行前临时改动。">
      <Field
        label="FFmpeg 路径"
        value={settings.alignment.ffmpegPath}
        placeholder="留空使用 PATH 中的 ffmpeg"
        onChange={(event) =>
          onChange({
            ...settings,
            alignment: { ...settings.alignment, ffmpegPath: event.target.value }
          })
        }
      />
      <div className="grid grid-cols-3 gap-3">
        <Field
          label="窗口 ms"
          type="number"
          min={1}
          value={settings.alignment.windowMs}
          onChange={(event) =>
            onChange({
              ...settings,
              alignment: { ...settings.alignment, windowMs: readNumericInput(event.target.value) }
            })
          }
        />
        <Field
          label="最小缺失 ms"
          type="number"
          min={0}
          value={settings.alignment.minGapMs}
          onChange={(event) =>
            onChange({
              ...settings,
              alignment: { ...settings.alignment, minGapMs: readNumericInput(event.target.value) }
            })
          }
        />
        <Field
          label="匹配阈值"
          type="number"
          min={0.01}
          step={0.01}
          value={settings.alignment.matchThreshold}
          onChange={(event) =>
            onChange({
              ...settings,
              alignment: { ...settings.alignment, matchThreshold: readNumericInput(event.target.value) }
            })
          }
        />
      </div>
      <InfoBox>窗口越小越容易靠近真实边界，但特征数量和运算量也会增加。</InfoBox>
    </SettingsSection>
  );
}

function PrivacySettingsPanel({
  onExportSettings,
  onImportSettings
}: {
  onExportSettings: () => void;
  onImportSettings: () => void;
}) {
  return (
    <SettingsSection title="隐私与本地数据" description="本工具默认以本地文件和本机授权服务为边界。">
      <div className="flex flex-wrap gap-2">
        <TextButton onClick={onExportSettings}>
          <Download size={14} />
          导出设置
        </TextButton>
        <TextButton onClick={onImportSettings}>
          <Upload size={14} />
          导入设置
        </TextButton>
      </div>
      <InfoBox>
        项目文件只保存弹幕、媒体引用和编辑状态，不嵌入视频内容，也不会保存 Emby 密码或 token。
      </InfoBox>
      <InfoBox>
        本地应用设置只保存默认导出目录、服务器地址、路径前缀、用户名、FFmpeg 路径和对齐默认参数。设置备份会带 schemaVersion，旧版无版本备份仍可导入。桌面端优先写入 Tauri 应用配置目录，网页模式使用浏览器本地存储。Emby 密码只保存在当前应用进程内，关闭应用后失效；清除本地设置也会清除会话密码。
      </InfoBox>
      <InfoBox>
        当前版本不实现视频下载、DRM 绕过、账号绕过、私有接口爬取或未授权媒体访问。
      </InfoBox>
    </SettingsSection>
  );
}

function AboutSettingsPanel() {
  return (
    <SettingsSection title="关于" description="Danmaku Timeline Studio 产品成熟度提升版。">
      <div className="grid gap-2 text-xs text-slate-300">
        <InfoRow label="版本" value="0.1.0" />
        <InfoRow label="风格方向" value="Windows 11 / PowerToys 式工具外壳 + 深色专业时间线工作区" />
        <InfoRow label="当前阶段" value="成熟度提升主线：音频对齐、版本差异复核与项目安全硬化" />
        <InfoRow label="数据边界" value="用户主动导入的本地文件和用户授权访问的媒体元数据" />
      </div>
    </SettingsSection>
  );
}

function SettingsSection({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4">
      <div>
        <h3 className="text-base font-semibold text-slate-100">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
      </div>
      <div className="grid gap-4 rounded border border-panel-line bg-panel-soft p-4">{children}</div>
    </section>
  );
}

function ToggleRow({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between text-xs text-slate-300">
      {label}
      <input
        type="checkbox"
        checked={checked}
        className="h-4 w-4 accent-accent-cyan"
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function InfoBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-accent-cyan/20 bg-accent-cyan/10 p-3 text-xs leading-5 text-slate-300">
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 border-b border-panel-line py-2 last:border-b-0">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-200">{value}</span>
    </div>
  );
}

function readNumericInput(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function setStatus(message: string, tone: "success" | "warning" | "error" | "neutral") {
  useEditorStore.setState({ status: { message, tone } });
}

function formatSettingsImportError(file: File, error: unknown): string {
  const detail = formatDesktopSettingsError(error);
  if (detail.includes(file.name)) {
    return `导入设置失败：${detail}`;
  }
  return `导入设置失败：${file.name}：${detail}`;
}
