import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
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
});
