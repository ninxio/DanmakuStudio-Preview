export async function readTextFile(file: File): Promise<string> {
  if (typeof file.text === "function") {
    return file.text();
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
    reader.onerror = () => reject(new Error("读取文件失败。"));
    reader.readAsText(file);
  });
}

export async function readFilesAsText(files: FileList | File[]): Promise<Array<{ file: File; text: string }>> {
  const fileArray = Array.from(files);
  return Promise.all(
    fileArray.map(async (file) => ({
      file,
      text: await readTextFile(file)
    }))
  );
}

export function createObjectUrl(file: File): string {
  return URL.createObjectURL(file);
}

export function revokeObjectUrl(url: string | null): void {
  if (url) {
    URL.revokeObjectURL(url);
  }
}

export function downloadTextFile(fileName: string, content: string, type = "text/plain;charset=utf-8"): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadTextFiles(
  files: Array<{ fileName: string; content: string }>,
  type = "text/plain;charset=utf-8"
): void {
  for (const file of files) {
    downloadTextFile(file.fileName, file.content, type);
  }
}
