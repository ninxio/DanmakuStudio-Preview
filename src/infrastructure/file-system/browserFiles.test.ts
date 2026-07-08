import { describe, expect, it } from "vitest";
import { createStoredZip } from "./browserFiles";

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
