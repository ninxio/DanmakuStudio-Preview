import { describe, expect, it, vi } from "vitest";
import { createStoredZip, downloadTextFile, downloadTextFiles, sanitizeDownloadFileName } from "./browserFiles";

describe("浏览器文件导出", () => {
  it("把多份 XML 打包成包含全部条目的 ZIP", async () => {
    const zip = createStoredZip([
      { fileName: "S01E01.xml", content: "<i><d p=\"0,1,25,16777215,0,0,u,r\">一</d></i>" },
      { fileName: "S01E02.xml", content: "<i><d p=\"1,1,25,16777215,0,0,u,r\">二</d></i>" }
    ]);

    expect(zip.type).toBe("application/zip");
    await expect(readCentralDirectoryNames(zip)).resolves.toEqual(["S01E01.xml", "S01E02.xml"]);
  });

  it("打包时清理非法路径字符并避免重名覆盖", async () => {
    const zip = createStoredZip([
      { fileName: "S01/E01.xml", content: "<i />" },
      { fileName: "S01/E01.xml", content: "<i />" }
    ]);

    await expect(readCentralDirectoryNames(zip)).resolves.toEqual(["S01_E01.xml", "S01_E01 (2).xml"]);
  });

  it("下载文件名会清理路径字符和 Windows 保留名", () => {
    expect(sanitizeDownloadFileName(" 健康/报告:项目?.txt ")).toBe("健康_报告_项目_.txt");
    expect(sanitizeDownloadFileName("CON.xml")).toBe("_CON.xml");
    expect(sanitizeDownloadFileName("   ", "export.xml")).toBe("export.xml");
  });

  it("单文件下载返回实际使用的文件名", () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:text-download");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });

    try {
      const fileName = downloadTextFile("报告/项目?.txt", "内容");

      expect(fileName).toBe("报告_项目_.txt");
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("单文件下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("报告_项目_.txt");
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:text-download");
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

  it("多文件下载支持自定义压缩包名并返回实际下载名", () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:danmaku-archive");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });

    try {
      const result = downloadTextFiles(
        [
          { fileName: "S01E01.xml", content: "<i />" },
          { fileName: "S01E02.xml", content: "<i />" }
        ],
        "application/xml;charset=utf-8",
        "合集/导出:项目.zip"
      );

      expect(result).toEqual({ fileCount: 2, archiveFileName: "合集_导出_项目.zip" });
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("多文件下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("合集_导出_项目.zip");
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:danmaku-archive");
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
});

async function readCentralDirectoryNames(zip: Blob): Promise<string[]> {
  const bytes = new Uint8Array(await readBlobAsArrayBuffer(zip));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const names: string[] = [];
  let offset = 0;
  while (offset < bytes.byteLength - 4) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    names.push(decoder.decode(bytes.slice(nameStart, nameEnd)));
    offset = nameEnd + extraLength + commentLength;
  }
  return names;
}

function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  const modernBlob = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof modernBlob.arrayBuffer === "function") {
    return modernBlob.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error("Blob 读取结果不是 ArrayBuffer。"));
    };
    reader.onerror = () => reject(new Error("Blob 读取失败。"));
    reader.readAsArrayBuffer(blob);
  });
}
