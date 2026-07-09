import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import { AssetPanel } from "./AssetPanel";

describe("资源面板", () => {
  beforeEach(() => {
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,r">测试</d></i>`,
      { fileName: "01 - 1.1.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset]
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null
    });
  });

  it("可以从资源栏删除已导入的弹幕文件", async () => {
    const user = userEvent.setup();
    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(useEditorStore.getState().project.assets).toHaveLength(0));
  });

  it("主界面的 Emby 时长面板只保留搜索入口", () => {
    render(<AssetPanel />);

    expect(screen.getByText("Emby 时长")).toBeInTheDocument();
    expect(screen.getByLabelText("搜索")).toBeInTheDocument();
    expect(screen.queryByLabelText("服务器")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("路径")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("用户名")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
  });

  it("可以把疑似删减候选转为待确认补偿点", async () => {
    const user = userEvent.setup();
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i>
        <d p="10,1,25,16777215,0,0,u1,r1">这里是不是删了</d>
        <d p="20,1,25,16777215,0,0,u2,r2">刚才怎么跳了</d>
        <d p="25,1,25,16777215,0,0,u3,r3">少了一段吧</d>
      </i>`,
      { fileName: "第一季1-2.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset]
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null
    });

    render(<AssetPanel />);
    expect(screen.getByText("疑似删减点")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "转为补偿点" }));

    await waitFor(() => expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1));
    const marker = useEditorStore.getState().project.cutMarkers[0];
    expect(marker.name).toContain("待确认补偿");
    expect(marker.sourceAtMs).toBe(20_000);
    expect(marker.note).toContain("第一季1-2.xml");
  });

  it("可以应用锚点校准推断出的补偿点", async () => {
    const user = userEvent.setup();
    render(<AssetPanel />);

    await user.type(screen.getByPlaceholderText(/每行一个对应点/), "00:10 -> 00:10\n00:20 -> 00:30");
    await user.click(screen.getByRole("button", { name: "应用锚点与补偿" }));

    await waitFor(() => expect(useEditorStore.getState().project.syncAnchors).toHaveLength(2));
    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1);
    expect(useEditorStore.getState().project.cutMarkers[0]).toMatchObject({
      sourceAtMs: 20_000,
      targetGapMs: 10_000
    });
  });

  it("可以导入并应用音频 CLI 输出的对齐提案", async () => {
    const user = userEvent.setup();
    const proposal = {
      anchors: [{ id: "audio-anchor-1", sourceMs: 20_000, targetMs: 40_000, origin: "automatic", confidence: 0.9 }],
      cutCandidates: [
        {
          id: "audio-gap-1",
          name: "音频推断补偿 1",
          sourceAtMs: 20_000,
          targetGapMs: 20_000,
          confidence: 0.9,
          note: "音频对齐候选"
        }
      ],
      confidence: 0.9,
      diagnostics: ["音频特征匹配 4 / 4 帧。"]
    };
    render(<AssetPanel />);

    fireEvent.change(screen.getByPlaceholderText("AlignmentProposal JSON"), {
      target: { value: JSON.stringify(proposal) }
    });
    await user.click(screen.getByRole("button", { name: "导入提案" }));
    await waitFor(() => expect(useEditorStore.getState().alignmentProposal?.cutCandidates).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "应用候选" }));

    await waitFor(() => expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1));
    expect(useEditorStore.getState().project.syncAnchors).toHaveLength(1);
    expect(useEditorStore.getState().project.cutMarkers[0]).toMatchObject({
      sourceAtMs: 20_000,
      targetGapMs: 20_000,
      note: "音频对齐候选"
    });
  });

  it("可以导出当前音频对齐提案 JSON", async () => {
    const user = userEvent.setup();
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:alignment-proposal");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const proposal = {
      anchors: [{ id: "audio-anchor-1", sourceMs: 20_000, targetMs: 40_000, origin: "automatic", confidence: 0.9 }],
      cutCandidates: [
        {
          id: "audio-gap-1",
          name: "音频推断补偿 1",
          sourceAtMs: 20_000,
          targetGapMs: 20_000,
          confidence: 0.9,
          note: "音频对齐候选"
        }
      ],
      confidence: 0.9,
      diagnostics: ["音频特征匹配 4 / 4 帧。"]
    };

    try {
      render(<AssetPanel />);
      fireEvent.change(screen.getByPlaceholderText("AlignmentProposal JSON"), {
        target: { value: JSON.stringify(proposal) }
      });
      await user.click(screen.getByRole("button", { name: "导入提案" }));
      await user.click(screen.getByRole("button", { name: "导出提案" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const [blob] = createObjectUrl.mock.calls[0];
      if (!(blob instanceof Blob)) {
        throw new Error("导出的对象不是 Blob。");
      }
      await expect(readBlobText(blob)).resolves.toContain("audio-gap-1");
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:alignment-proposal");
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
