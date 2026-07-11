import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyProject } from "../../domain/project/factory";
import { createHistoryState } from "../../domain/history/history";
import { useEditorStore } from "../../stores/editorStore";
import { WorkspaceProgressBanner } from "./WorkspaceProgressBanner";

describe("WorkspaceProgressBanner", () => {
  beforeEach(() => {
    useEditorStore.setState({
      project: createEmptyProject(),
      history: createHistoryState(),
      workspacePage: "materials"
    });
  });

  it("空项目显示素材页引导并推荐下一步", () => {
    render(<WorkspaceProgressBanner pageId="materials" />);
    expect(screen.getByTestId("workspace-progress-banner")).toBeInTheDocument();
    expect(screen.getByText("先导入原片、参考视频和弹幕 XML")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /素材/ })).toHaveAttribute("aria-current", "step");
  });

  it("可以点击步骤跳转到其他页面", async () => {
    const user = userEvent.setup();
    render(<WorkspaceProgressBanner pageId="materials" />);
    await user.click(screen.getByRole("button", { name: /匹配/ }));
    expect(useEditorStore.getState().workspacePage).toBe("matching");
  });
});
