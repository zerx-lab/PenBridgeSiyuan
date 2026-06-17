import {
    Plugin,
    showMessage,
    Dialog,
    getAllEditor,
    Menu,
} from "siyuan";
import "./index.scss";

import { exportMdContent } from "./api";
import Settings from "./components/settings.svelte";
import PublishDialog from "./components/publish-dialog.svelte";
import ChatDock from "./components/chat-dock.svelte";
import { PLATFORMS } from "./platforms/registry";
import { PublishScheduler } from "./scheduler";
import { logger } from "./logger";

const CONFIG_KEY = "tencent-config";
const RECORDS_KEY = "publish-records";

export default class PenBridgePlugin extends Plugin {
    scheduler!: PublishScheduler;

    async onload() {
        // 初始化持久化数据
        await this.loadData(CONFIG_KEY);
        await this.loadData(RECORDS_KEY);

        // 载入定时任务并修复中断状态（轮询在 onLayoutReady 中启动）
        this.scheduler = new PublishScheduler(this);
        await this.scheduler.load();

        // 注册图标：发布（纸飞机）、定时任务（时钟）
        this.addIcons(`<symbol id="iconPenBridge" viewBox="0 0 32 32">
<path d="M30.7 1.3c-0.4-0.4-1-0.5-1.5-0.3l-28 12c-0.5 0.2-0.9 0.8-0.9 1.4 0 0.6 0.4 1.1 1 1.3l10.6 3.5 3.5 10.6c0.2 0.6 0.7 1 1.3 1h0.1c0.6 0 1.1-0.4 1.3-0.9l12-28c0.2-0.5 0.1-1.1-0.4-1.6zM25.3 4.7l-13.1 13.1-7.4-2.5 20.5-10.6zM16.7 27.2l-2.5-7.4 13.1-13.1-10.6 20.5z"></path>
</symbol>
<symbol id="iconPenBridgeClock" viewBox="0 0 32 32">
<path d="M16 2C8.27 2 2 8.27 2 16s6.27 14 14 14 14-6.27 14-14S23.73 2 16 2zm0 25.2C9.82 27.2 4.8 22.18 4.8 16S9.82 4.8 16 4.8 27.2 9.82 27.2 16 22.18 27.2 16 27.2zM17.4 8h-2.8v9.16l7.07 4.24 1.44-2.4-5.71-3.42V8z"></path>
</symbol>
<symbol id="iconPenBridgeCli" viewBox="0 0 32 32">
<path d="M4 6h24a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm1 3v14h22V9H5zm3 2.5l5 4-5 4-1.7-1.5 3.2-2.5-3.2-2.5L8 11.5zM15 18h7v2h-7v-2z"></path>
</symbol>`);
    }

    onLayoutReady() {
        // 启动定时任务轮询：立即检查一次，补发关闭期间到期的任务
        this.scheduler.start();

        const topBarElement = this.addTopBar({
            icon: "iconPenBridge",
            title: this.i18n.topBarTitle,
            position: "right",
            callback: () => {
                let rect = topBarElement.getBoundingClientRect();
                if (rect.width === 0) {
                    rect = document.querySelector("#barMore")?.getBoundingClientRect() ?? rect;
                }
                if (rect.width === 0) {
                    rect = document.querySelector("#barPlugins")?.getBoundingClientRect() ?? rect;
                }

                const menu = new Menu("penbridge-platform-menu");
                for (const platform of PLATFORMS) {
                    const label = platform.available
                        ? this.i18n[platform.name]
                        : `${this.i18n[platform.name]}（${this.i18n.comingSoon}）`;
                    menu.addItem({
                        label,
                        icon: platform.available ? "iconPenBridge" : "",
                        disabled: !platform.available,
                        click: () => {
                            if (platform.id === "tencent") {
                                this.quickPublish();
                            }
                        },
                    });
                }

                menu.addSeparator();
                const pending = this.scheduler.pendingCount;
                menu.addItem({
                    label: pending > 0
                        ? `${this.i18n.scheduledTasks}（${pending}）`
                        : this.i18n.scheduledTasks,
                    icon: "iconPenBridgeClock",
                    click: () => {
                        this.openSetting("tasks");
                    },
                });
                menu.addItem({
                    label: this.i18n.settings,
                    icon: "iconSettings",
                    click: () => {
                        this.openSetting();
                    },
                });

                menu.open({ x: rect.right, y: rect.bottom, isLeft: true });
            },
        });

        // 右侧 AI 对话面板：pi SDK 驱动，直接读写当前激活思源文档
        let chatDock: ChatDock | undefined;
        this.addDock({
            config: {
                position: "RightTop",
                size: { width: 360, height: 0 },
                icon: "iconPenBridgeCli",
                title: this.i18n.aiDockTitle,
            },
            data: {},
            type: "penbridge-ai-dock",
            init: (dock) => {
                chatDock = new ChatDock({
                    target: dock.element,
                    props: { plugin: this },
                });
            },
            destroy: () => {
                chatDock?.$destroy();
                chatDock = undefined;
            },
        });
    }

    onunload() {
        this.scheduler?.destroy();
    }

    openSetting(initialTab?: string): void {
        const dialog = new Dialog({
            title: this.i18n.settingTitle,
            content: `<div id="PenBridgeSettings" style="height:100%;"></div>`,
            width: "720px",
            height: "480px",
            destroyCallback: () => {
                panel?.$destroy();
            },
        });
        const panel = new Settings({
            target: dialog.element.querySelector("#PenBridgeSettings"),
            props: {
                plugin: this,
                ...(initialTab ? { initialTab } : {}),
            },
        });
    }

    private getActiveEditor() {
        const editors = getAllEditor();
        if (editors.length === 0) return undefined;
        // 1) 光标选区所在 editor
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
            const node = sel.getRangeAt(0).startContainer;
            const el = node instanceof Element ? node : node.parentElement;
            const found = editors.find((e) => e.protyle?.element?.contains(el));
            if (found) return found;
        }
        // 2) 激活窗口中可见的 editor
        const active = editors.find((e) => {
            const el = e.protyle?.element;
            return el && !el.classList.contains("fn__none") && el.closest(".layout__wnd--active");
        });
        if (active) return active;
        // 3) 兜底：第一个可见 editor
        return (
            editors.find((e) => e.protyle?.element && !e.protyle.element.classList.contains("fn__none")) ??
            editors[0]
        );
    }

    private async quickPublish() {
        try {
        // 1. 检查配置
        const config = await this.loadData(CONFIG_KEY);
        if (!config || typeof config !== "object" || !config.cookie) {
            showMessage(this.i18n.needCookie, 6000, "error");
            this.openSetting();
            return;
        }

        // 2. 取当前文档
        const protyle = this.getActiveEditor()?.protyle;
        const docId = protyle?.block?.rootID;
        if (!docId) {
            showMessage(this.i18n.noDocOpen, 6000, "error");
            return;
        }

        // 3. 导出 Markdown
        // addTitle/yfm 关闭：标题与标签由发布参数单独提交，避免正文顶部重复标题
        const res = await exportMdContent(docId, { addTitle: false, yfm: false });
        const markdown = res.content;
        if (!markdown) {
            showMessage(this.i18n.noDocOpen, 6000, "error");
            return;
        }
        const defaultTitle = res.hPath.split("/").pop() ?? "";

        // 4. 弹出发布对话框
        const dialog = new Dialog({
            title: this.i18n.topBarTitle,
            content: `<div id="PenBridgePublish"></div>`,
            width: "640px",
            destroyCallback: () => {
                panel?.$destroy();
            },
        });
        const panel = new PublishDialog({
            target: dialog.element.querySelector("#PenBridgePublish"),
            props: {
                plugin: this,
                docId,
                defaultTitle,
                markdown,
                onClose: () => {
                    dialog.destroy();
                },
            },
        });
        } catch (e: any) {
            logger.error("quickPublish failed:", e);
            showMessage(`${this.i18n.publishFailed}: ${e?.message ?? e}`, 6000, "error");
        }
    }
}
