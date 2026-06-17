import { getAllEditor, type IProtyle } from "siyuan";

/**
 * 当前激活的 protyle（三级兜底，与发布流程取文档口径一致）：
 * 1) 光标选区所在 editor 2) 激活窗口中可见 editor 3) 首个可见 editor。
 */
export function getActiveProtyle(): IProtyle | undefined {
    const editors = getAllEditor();
    if (editors.length === 0) return undefined;

    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
        const node = sel.getRangeAt(0).startContainer;
        const el = node instanceof Element ? node : node.parentElement;
        const found = editors.find((e) => e.protyle?.element?.contains(el));
        if (found?.protyle) return found.protyle;
    }

    const active = editors.find((e) => {
        const el = e.protyle?.element;
        return el && !el.classList.contains("fn__none") && el.closest(".layout__wnd--active");
    });
    if (active?.protyle) return active.protyle;

    const visible = editors.find(
        (e) => e.protyle?.element && !e.protyle.element.classList.contains("fn__none"),
    );
    return visible?.protyle ?? editors[0]?.protyle;
}

/** 当前激活文档的根块 ID（无则 undefined）。 */
export function getActiveDocId(): string | undefined {
    return getActiveProtyle()?.block?.rootID;
}
