import { describe, expect, it, vi } from "vitest";
import {
  openExportDirectoryPath,
  saveTextExportFile,
  saveTextExportFiles,
  type DesktopExportFileRequest,
  type ExportFilesBridge
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
});

function createBridge(): ExportFilesBridge {
  return {
    isAvailable: () => true,
    saveFile: vi.fn((request: DesktopExportFileRequest) =>
      Promise.resolve({
        fileName: request.fileName,
        filePath: `${request.directoryPath}\\${request.fileName}`,
        directoryPath: request.directoryPath,
        wasRenamed: false
      })
    ),
    openDirectory: vi.fn(() => Promise.resolve())
  };
}
