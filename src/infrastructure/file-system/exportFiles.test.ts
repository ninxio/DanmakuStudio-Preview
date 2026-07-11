import { describe, expect, it, vi } from "vitest";
import {
  getVerifiedExportUnavailableReason,
  openExportDirectoryPath,
  saveTextExportFile,
  saveTextExportFiles,
  type DesktopExportFileRequest,
  type ExportFilesBridge,
  type VerifiedExportVerification
} from "./exportFiles";

describe("导出文件服务", () => {
  it("有桌面目录时写入安全文件名并返回打开目录动作所需路径", async () => {
    const bridge = createBridge();

    const result = await saveTextExportFile(
      { fileName: "导出/XML:项目.xml", content: "<i />" },
      { directoryPath: " D:\\exports ", type: "application/xml;charset=utf-8" },
      bridge
    );

    expect(result).toMatchObject({
      mode: "directory",
      fileName: "导出_XML_项目.xml",
      filePath: "D:\\exports\\导出_XML_项目.xml",
      directoryPath: "D:\\exports"
    });
    expect(bridge.saveFile).toHaveBeenCalledWith({
      directoryPath: "D:\\exports",
      fileName: "导出_XML_项目.xml",
      contentBytes: Array.from(new TextEncoder().encode("<i />"))
    });
  });

  it("多个分集在目录模式下打包为 ZIP", async () => {
    const bridge = createBridge();

    const result = await saveTextExportFiles(
      [
        { fileName: "1.xml", content: "<i>1</i>" },
        { fileName: "2.xml", content: "<i>2</i>" }
      ],
      { directoryPath: "D:\\exports", archiveFileName: "合集/导出.zip" },
      bridge
    );

    expect(result).toMatchObject({
      mode: "directory",
      fileCount: 2,
      fileName: "合集_导出.zip"
    });
    const [request] = vi.mocked(bridge.saveFile).mock.calls[0];
    expect(request.fileName).toBe("合集_导出.zip");
    expect(request.contentBytes.slice(0, 4)).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("打开目录会调用桌面桥", async () => {
    const bridge = createBridge();

    await openExportDirectoryPath("D:\\exports", bridge);

    expect(bridge.openDirectory).toHaveBeenCalledWith("D:\\exports");
  });

  it("高精度导出只调用携带媒体依赖的原子复核写盘命令", async () => {
    const bridge = createBridge();
    const verification = createVerification();
    const isSnapshotCurrent = vi.fn(() => true);

    await saveTextExportFile(
      { fileName: "episode.xml", content: "<i />" },
      { directoryPath: "D:\\exports", verification, isSnapshotCurrent },
      bridge
    );

    expect(isSnapshotCurrent).toHaveBeenCalledTimes(1);
    expect(bridge.saveFile).not.toHaveBeenCalled();
    expect(bridge.saveVerifiedFile).toHaveBeenCalledWith({
      directoryPath: "D:\\exports",
      fileName: "episode.xml",
      contentBytes: Array.from(new TextEncoder().encode("<i />")),
      verification
    });
  });

  it("高精度导出在浏览器环境和缺少桌面目录时都严格阻断", async () => {
    const unavailableBridge = { ...createBridge(), isAvailable: () => false };
    await expect(
      saveTextExportFile(
        { fileName: "episode.xml", content: "<i />" },
        {
          directoryPath: "D:\\exports",
          verification: createVerification(),
          isSnapshotCurrent: () => true
        },
        unavailableBridge
      )
    ).rejects.toThrow("仅可在支持写盘前媒体身份复核的桌面端使用");

    await expect(
      saveTextExportFile(
        { fileName: "episode.xml", content: "<i />" },
        { verification: createVerification(), isSnapshotCurrent: () => true },
        createBridge()
      )
    ).rejects.toThrow("必须先在设置中选择桌面导出文件夹");
  });

  it("项目快照变化时不会向原子写盘命令发送内容", async () => {
    const bridge = createBridge();

    await expect(
      saveTextExportFiles(
        [
          { fileName: "1.xml", content: "<i>1</i>" },
          { fileName: "2.xml", content: "<i>2</i>" }
        ],
        {
          directoryPath: "D:\\exports",
          verification: createVerification(),
          isSnapshotCurrent: () => false
        },
        bridge
      )
    ).rejects.toThrow("项目或导出内容在身份核验期间发生变化");

    expect(bridge.saveVerifiedFile).not.toHaveBeenCalled();
    expect(bridge.saveFile).not.toHaveBeenCalled();
  });

  it("可在点击前解释 verified save 的桌面能力或目录缺口", () => {
    expect(getVerifiedExportUnavailableReason("", createBridge())).toContain(
      "选择桌面导出文件夹"
    );
    expect(
      getVerifiedExportUnavailableReason("D:\\exports", {
        ...createBridge(),
        isAvailable: () => false
      })
    ).toContain("仅可在支持写盘前媒体身份复核的桌面端使用");
    expect(getVerifiedExportUnavailableReason("D:\\exports", createBridge())).toBeNull();
  });
});

function createBridge(): ExportFilesBridge {
  const createResult = (request: DesktopExportFileRequest) =>
    Promise.resolve({
      fileName: request.fileName,
      filePath: `${request.directoryPath}\\${request.fileName}`,
      directoryPath: request.directoryPath,
      wasRenamed: false
    });
  return {
    isAvailable: () => true,
    saveFile: vi.fn(createResult),
    saveVerifiedFile: vi.fn(createResult),
    openDirectory: vi.fn(() => Promise.resolve())
  };
}

function createVerification(): VerifiedExportVerification {
  return {
    projectId: "project-1",
    projectUpdatedAt: "2026-07-12T00:00:00.000Z",
    snapshotDigest: "fnv1a32:12345678",
    dependencies: [
      {
        mediaId: "source-1",
        path: "D:\\media\\source.mkv",
        expectedIdentity: {
          algorithm: "sha256-full-file-v2",
          sizeBytes: 1024,
          modifiedUnixMs: 1_752_278_400_000,
          firstSampleDigest: "a".repeat(64),
          middleSampleDigest: "a".repeat(64),
          lastSampleDigest: "a".repeat(64)
        },
        mapIds: ["map-1"]
      }
    ]
  };
}
