import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PageFeedbackToolbarCSS } from "./index";
import { SharedMarker } from "./annotation-marker";
import { SettingsPanel, type SettingsPanelProps } from "./settings-panel";
import type { Annotation } from "../../types";

// Mock clipboard API
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
};

beforeEach(() => {
  vi.stubGlobal("navigator", {
    clipboard: mockClipboard,
    userAgent: "test-agent",
  });
  mockClipboard.writeText.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PageFeedbackToolbarCSS", () => {
  describe("onAnnotationAdd callback", () => {
    it("should accept onAnnotationAdd prop without errors", () => {
      const handleAnnotation = vi.fn();
      expect(() =>
        render(<PageFeedbackToolbarCSS onAnnotationAdd={handleAnnotation} />)
      ).not.toThrow();
    });

    it("should type-check annotation callback parameter", () => {
      // This test verifies TypeScript types are correct at compile time
      const handleAnnotation = (annotation: Annotation) => {
        // Verify all expected properties are accessible
        expect(annotation).toHaveProperty("id");
        expect(annotation).toHaveProperty("x");
        expect(annotation).toHaveProperty("y");
        expect(annotation).toHaveProperty("comment");
        expect(annotation).toHaveProperty("element");
        expect(annotation).toHaveProperty("elementPath");
        expect(annotation).toHaveProperty("timestamp");
      };

      render(<PageFeedbackToolbarCSS onAnnotationAdd={handleAnnotation} />);
    });
  });

  describe("copyToClipboard prop", () => {
    it("should default copyToClipboard to true", () => {
      // Component should render without explicit copyToClipboard prop
      expect(() => render(<PageFeedbackToolbarCSS />)).not.toThrow();
    });

    it("should accept copyToClipboard={false} without errors", () => {
      expect(() =>
        render(<PageFeedbackToolbarCSS copyToClipboard={false} />)
      ).not.toThrow();
    });

    it("should accept copyToClipboard={true} without errors", () => {
      expect(() =>
        render(<PageFeedbackToolbarCSS copyToClipboard={true} />)
      ).not.toThrow();
    });
  });

  describe("sharedAnnotations prop", () => {
    const shared: Annotation = {
      id: "shared-1",
      x: 50,
      y: 100,
      comment: "Button is hidden on mobile",
      element: "button",
      elementPath: "body > button",
      timestamp: 1,
      authorId: "linh@example.com",
    };

    it("should accept sharedAnnotations without errors", () => {
      expect(() => render(<PageFeedbackToolbarCSS sharedAnnotations={[shared]} />)).not.toThrow();
    });

    it("should show comment and author only while hovered", () => {
      const props = { annotation: shared, onHoverEnter: vi.fn(), onHoverLeave: vi.fn() };
      const { rerender } = render(<SharedMarker {...props} isHovered={false} />);
      expect(screen.queryByText("Button is hidden on mobile")).toBeNull();

      rerender(<SharedMarker {...props} isHovered />);
      expect(screen.getByText("Button is hidden on mobile")).toBeTruthy();
      expect(screen.getByText("linh")).toBeTruthy();
    });

    it("should report hover so the toolbar can show the tooltip", () => {
      const onHoverEnter = vi.fn();
      const { container } = render(
        <SharedMarker annotation={shared} isHovered={false} onHoverEnter={onHoverEnter} onHoverLeave={vi.fn()} />
      );
      fireEvent.mouseEnter(container.firstChild as Element);
      expect(onHoverEnter).toHaveBeenCalledWith(shared);
    });
  });

  describe("features prop", () => {
    it("should show every tool by default", () => {
      render(<PageFeedbackToolbarCSS />);
      expect(screen.getByText("Copy feedback")).toBeTruthy();
      expect(screen.getByText("Clear all")).toBeTruthy();
      expect(screen.getByText("Layout mode")).toBeTruthy();
    });

    it("should hide tools that are turned off and keep the rest", () => {
      render(
        <PageFeedbackToolbarCSS
          features={{ copy: false, clear: false, layout: false, settings: false }}
        />
      );
      expect(screen.queryByText("Copy feedback")).toBeNull();
      expect(screen.queryByText("Clear all")).toBeNull();
      expect(screen.queryByText("Layout mode")).toBeNull();
      expect(screen.queryByText("Settings")).toBeNull();
      expect(screen.getByText("Pause animations")).toBeTruthy();
    });
  });

  describe("actions prop", () => {
    it("should render custom actions and call onClick", () => {
      const onClick = vi.fn();
      render(
        <PageFeedbackToolbarCSS
          actions={[{ id: "open-panel", label: "Open panel", icon: <svg />, onClick }]}
        />
      );
      // Toolbar renders in a portal; getByRole trips jsdom's selector engine on its CSS
      const button = document.querySelector('button[aria-label="Open panel"]');
      expect(button).toBeTruthy();
      fireEvent.click(button as Element);
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe("settings panel features", () => {
    const baseProps: Omit<SettingsPanelProps, "features"> = {
      settings: {
        outputDetail: "standard",
        autoClearAfterCopy: false,
        annotationColorId: "blue",
        blockInteractions: true,
        reactEnabled: true,
        markerClickBehavior: "edit",
        webhookUrl: "",
        webhooksEnabled: false,
      },
      onSettingsChange: vi.fn(),
      isDarkMode: true,
      onToggleTheme: vi.fn(),
      isDevMode: true,
      connectionStatus: "disconnected",
      isVisible: true,
      toolbarNearBottom: false,
      settingsPage: "main",
      onSettingsPageChange: vi.fn(),
      onHideToolbar: vi.fn(),
    };

    it("should show React, version and webhooks by default", () => {
      render(<SettingsPanel {...baseProps} features={{ reactComponents: true, version: true, webhooks: true }} />);
      expect(screen.getByText("React Components")).toBeTruthy();
      expect(screen.getByText("Webhooks")).toBeTruthy();
      expect(screen.getAllByText("Manage MCP & Webhooks").length).toBeGreaterThan(0);
    });

    it("should hide React, version and webhooks when turned off", () => {
      const { container } = render(
        <SettingsPanel {...baseProps} features={{ reactComponents: false, version: false, webhooks: false }} />
      );
      expect(screen.queryByText("React Components")).toBeNull();
      expect(screen.queryByText("Webhooks")).toBeNull();
      expect(screen.getAllByText("Manage MCP").length).toBeGreaterThan(0);
      expect(container.textContent).not.toMatch(/v\d+\.\d+/);
    });
  });

  describe("combined props", () => {
    it("should accept both onAnnotationAdd and copyToClipboard props", () => {
      const handleAnnotation = vi.fn();
      expect(() =>
        render(
          <PageFeedbackToolbarCSS
            onAnnotationAdd={handleAnnotation}
            copyToClipboard={false}
          />
        )
      ).not.toThrow();
    });
  });
});

describe("Annotation type", () => {
  it("should include all required fields", () => {
    const annotation: Annotation = {
      id: "test-id",
      x: 50,
      y: 100,
      comment: "Test comment",
      element: "Button",
      elementPath: "body > div > button",
      timestamp: Date.now(),
    };

    expect(annotation.id).toBe("test-id");
    expect(annotation.x).toBe(50);
    expect(annotation.y).toBe(100);
    expect(annotation.comment).toBe("Test comment");
    expect(annotation.element).toBe("Button");
    expect(annotation.elementPath).toBe("body > div > button");
    expect(typeof annotation.timestamp).toBe("number");
  });

  it("should allow optional metadata fields", () => {
    const annotation: Annotation = {
      id: "test-id",
      x: 50,
      y: 100,
      comment: "Test comment",
      element: "Button",
      elementPath: "body > div > button",
      timestamp: Date.now(),
      selectedText: "Selected text content",
      boundingBox: { x: 100, y: 200, width: 150, height: 40 },
      nearbyText: "Context around the element",
      cssClasses: "btn btn-primary",
      nearbyElements: "div, span, a",
      computedStyles: "color: blue; font-size: 14px",
      fullPath: "html > body > div#app > main > button.btn",
      accessibility: "role=button, aria-label=Submit",
      isMultiSelect: false,
      isFixed: false,
    };

    expect(annotation.selectedText).toBe("Selected text content");
    expect(annotation.boundingBox).toEqual({
      x: 100,
      y: 200,
      width: 150,
      height: 40,
    });
    expect(annotation.cssClasses).toBe("btn btn-primary");
    expect(annotation.fullPath).toBe("html > body > div#app > main > button.btn");
    expect(annotation.accessibility).toBe("role=button, aria-label=Submit");
    expect(annotation.isMultiSelect).toBe(false);
    expect(annotation.isFixed).toBe(false);
  });
});
