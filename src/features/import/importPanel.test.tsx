import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { EditorToolbar } from "../editor/EditorToolbar";
import { useEditorStore } from "../../stores/editorStore";

describe("导入面板", () => {
  beforeEach(() => {
    useEditorStore.setState({
      project: createEmptyProject(),
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null
    });
  });

  afterEach(() => {
    useEditorStore.getState().newProject();
  });

  it("通过工具栏导入 XML 文件", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<EditorToolbar />);
    const xml = readFileSync(join(process.cwd(), "fixtures", "bilibili", "normal.xml"), "utf8");
    const file = new File([xml], "normal.xml", { type: "application/xml" });
    await user.upload(screen.getByTestId("xml-input"), file);
    unmount();
    await waitFor(() => expect(useEditorStore.getState().project.assets).toHaveLength(1));
    expect(useEditorStore.getState().project.assets[0].items).toHaveLength(3);
  });
});
