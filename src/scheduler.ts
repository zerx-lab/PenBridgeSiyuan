/**
 * 定时发布调度器
 * - 任务持久化到插件数据 scheduled-tasks，重启后自动恢复
 * - 30s 轮询检查到期任务；启动时立即检查一次，补发关闭期间到期的任务
 * - 上次运行中被强退的 running 任务恢复为 pending 重新执行
 * - 发布内容在任务执行时重新导出，保证发布的是文档最新内容
 */
import { showMessage, type Plugin } from "siyuan";
import { exportMdContent } from "./api";
import { TencentClient } from "./tencent/client";
import { runPublishJob } from "./tencent/publish";
import type { TagInfo, TencentConfig } from "./tencent/types";
import { logger } from "./logger";

export const TASKS_KEY = "scheduled-tasks";
const TICK_MS = 30_000;

/**
 * 当前设备 ID。桌面端基于硬件稳定且跨设备唯一，是多设备去重的执行权依据。
 * 取不到（异常环境）时返回空串，调用方据此降级为「不锁定」。
 */
export function currentDeviceId(): string {
    return (window as any).siyuan?.config?.system?.id ?? "";
}

export type TaskStatus = "pending" | "running" | "success" | "reviewing" | "failed" | "canceled";

export interface ScheduledTask {
    id: string;
    /** 预留多平台扩展，当前仅 "tencent" */
    platformId: string;
    docId: string;
    title: string;
    tags: TagInfo[];
    sourceType: number;
    /** 计划发布时间（ms） */
    scheduledAt: number;
    createdAt: number;
    status: TaskStatus;
    finishedAt?: number;
    error?: string;
    articleId?: number;
    /**
     * 执行该任务的设备 ID（window.siyuan.config.system.id）。
     * 多设备同步同一份任务数据时，仅 owner 设备执行，避免重复发布。
     * 兼容旧数据：缺省时由首个加载到的设备认领。
     */
    ownerDeviceId?: string;
}

/** 列表展示排序权重：进行中 > 待发布 > 失败 > 审核中 > 已发布 > 已取消 */
const STATUS_ORDER: Record<TaskStatus, number> = {
    running: 0,
    pending: 1,
    failed: 2,
    reviewing: 3,
    success: 4,
    canceled: 5,
};

export function formatDateTime(ms?: number): string {
    if (!ms) return "-";
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 腾讯云创作中心文章状态 → 任务状态
 * 移植自 penBridge articleSync.getStatusText：
 * - hostStatus=2（已提交发布）：status=2 已发布，其余审核中
 * - hostStatus=1 已发布(旧) → success
 * - hostStatus=3 未通过 → failed
 * - hostStatus=0 审核中 / 4 回收站 / 未知 → reviewing（保持不变）
 */
function mapArticleStatus(hostStatus: number, status?: number): TaskStatus {
    if (hostStatus === 2) return status === 2 ? "success" : "reviewing";
    if (hostStatus === 1) return "success";
    if (hostStatus === 3) return "failed";
    return "reviewing";
}

export class PublishScheduler {
    private plugin: Plugin;
    private tasks: ScheduledTask[] = [];
    private timer: number | undefined;
    private executing = new Set<string>();
    private listeners = new Set<() => void>();
    private checking = false;
    private refreshing = false;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
    }

    /** 载入持久化任务并修复中断状态（onload 调用） */
    async load(): Promise<void> {
        const data = await this.plugin.loadData(TASKS_KEY);
        this.tasks = Array.isArray(data) ? data : [];
        const me = currentDeviceId();
        let dirty = false;
        for (const task of this.tasks) {
            // 兼容旧数据：无 owner 的任务由首个加载到的设备认领，避免永不执行。
            // 仅认领未结束的任务（pending/running），已结束任务无需归属。
            if (!task.ownerDeviceId && me && (task.status === "pending" || task.status === "running")) {
                task.ownerDeviceId = me;
                dirty = true;
            }
            // 上次运行中途被强退的任务恢复为待发布——仅修复本设备 owner 的任务，
            // 别的设备同步过来的 running 是其正在执行的状态，不能擅自改写。
            if (task.status === "running" && (!task.ownerDeviceId || task.ownerDeviceId === me)) {
                task.status = "pending";
                dirty = true;
            }
        }
        if (dirty) await this.persist();
    }

    /** 启动轮询（onLayoutReady 调用）；立即检查一次，补发关闭期间到期的任务 */
    start(): void {
        if (this.timer !== undefined) return;
        void this.checkDueTasks();
        this.timer = window.setInterval(() => void this.checkDueTasks(), TICK_MS);
    }

    /**
     * 拉取平台最新发布状态，刷新「审核中」任务（进入定时任务页时调用）。
     * 仅在审核结果明确时（已发布 / 未通过）落库，避免与真实状态不一致。
     */
    async refreshStatuses(): Promise<void> {
        if (this.refreshing) return;
        // 仅审核中且已拿到 articleId 的腾讯任务需要回查
        const reviewing = this.tasks.filter(
            (t) => t.status === "reviewing" && t.platformId === "tencent" && !!t.articleId
        );
        if (reviewing.length === 0) return;

        const config = (await this.plugin.loadData("tencent-config")) as TencentConfig;
        if (!config?.cookie) return;

        this.refreshing = true;
        try {
            const articles = await new TencentClient(config.cookie).fetchCreatorArticles({
                hostStatus: 0,
                page: 1,
                pageSize: 50,
            });
            const byId = new Map(articles.map((a) => [a.articleId, a]));
            const i18n: any = this.plugin.i18n;

            let dirty = false;
            for (const task of reviewing) {
                const art = byId.get(task.articleId!);
                if (!art) continue;
                const next = mapArticleStatus(art.hostStatus, art.status);
                if (next === "success") {
                    task.status = "success";
                    task.error = undefined;
                    dirty = true;
                } else if (next === "failed") {
                    task.status = "failed";
                    task.error = art.rejectInfo?.reason || i18n.publishReviewFailed;
                    dirty = true;
                }
            }
            if (dirty) {
                await this.persist();
                this.notify();
            }
        } catch (e) {
            logger.error("refreshStatuses failed:", e);
        } finally {
            this.refreshing = false;
        }
    }

    destroy(): void {
        if (this.timer !== undefined) {
            window.clearInterval(this.timer);
            this.timer = undefined;
        }
        this.listeners.clear();
    }

    /** 订阅任务变更，返回取消订阅函数 */
    subscribe(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private notify(): void {
        for (const fn of this.listeners) fn();
    }

    getTasks(): ScheduledTask[] {
        return [...this.tasks].sort((a, b) => {
            if (STATUS_ORDER[a.status] !== STATUS_ORDER[b.status]) {
                return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
            }
            if (a.status === "pending") return a.scheduledAt - b.scheduledAt;
            return (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt);
        });
    }

    /** 待执行任务数（含进行中），用于菜单/导航角标 */
    get pendingCount(): number {
        return this.tasks.filter((t) => t.status === "pending" || t.status === "running").length;
    }

    async addTask(params: {
        platformId: string;
        docId: string;
        title: string;
        tags: TagInfo[];
        sourceType: number;
        scheduledAt: number;
    }): Promise<ScheduledTask> {
        const task: ScheduledTask = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            ...params,
            createdAt: Date.now(),
            status: "pending",
            // 绑定创建设备为执行者：仅该设备会执行此任务，杜绝多设备重复发布
            ownerDeviceId: currentDeviceId(),
        };
        this.tasks.push(task);
        await this.persist();
        this.notify();
        // 若时间已到期（如选了过去时间），立即触发检查
        void this.checkDueTasks();
        return task;
    }

    async cancelTask(id: string): Promise<void> {
        const task = this.tasks.find((t) => t.id === id);
        if (!task || task.status !== "pending") return;
        task.status = "canceled";
        task.finishedAt = Date.now();
        await this.persist();
        this.notify();
    }

    async deleteTask(id: string): Promise<void> {
        const task = this.tasks.find((t) => t.id === id);
        if (!task || task.status === "running") return;
        this.tasks = this.tasks.filter((t) => t.id !== id);
        await this.persist();
        this.notify();
    }

    /** 清除所有已结束（非 pending/running）的任务 */
    async clearFinished(): Promise<void> {
        this.tasks = this.tasks.filter((t) => t.status === "pending" || t.status === "running");
        await this.persist();
        this.notify();
    }

    /** 手动立即发布：待发布任务提前执行，失败任务重试 */
    async runNow(id: string): Promise<void> {
        const task = this.tasks.find((t) => t.id === id);
        if (!task || (task.status !== "pending" && task.status !== "failed")) return;
        // 手动执行即用本设备：改写 owner，避免执行后原 owner 设备再次自动发布
        const me = currentDeviceId();
        if (me) task.ownerDeviceId = me;
        await this.execute(task);
    }

    private async checkDueTasks(): Promise<void> {
        if (this.checking) return;
        this.checking = true;
        try {
            const now = Date.now();
            const me = currentDeviceId();
            // 仅自动执行本设备 owner 的任务，避免多设备同步同一份数据时重复发布。
            // 无 owner（取不到设备 ID 的降级场景）按本设备处理，保证不漏发。
            const due = this.tasks.filter(
                (t) =>
                    t.status === "pending" &&
                    t.scheduledAt <= now &&
                    (!t.ownerDeviceId || t.ownerDeviceId === me)
            );
            // 串行执行，避免对平台 API 的并发冲击
            for (const task of due) {
                await this.execute(task);
            }
        } catch (e) {
            logger.error("checkDueTasks failed:", e);
        } finally {
            this.checking = false;
        }
    }

    private async execute(task: ScheduledTask): Promise<void> {
        if (this.executing.has(task.id)) return;
        this.executing.add(task.id);
        const i18n: any = this.plugin.i18n;

        task.status = "running";
        task.error = undefined;
        await this.persist();
        this.notify();

        try {
            // 执行时重新导出，发布文档最新内容
            // addTitle/yfm 关闭：标题由任务单独提交，避免正文顶部重复标题
            // refMode=3（仅锚文本）：块引用只保留链接文字，避免被引文档整篇作为脚注混入正文
            const res = await exportMdContent(task.docId, { addTitle: false, yfm: false, refMode: 3 });
            if (!res?.content) throw new Error(i18n.taskDocMissing);

            const result = await runPublishJob(this.plugin, {
                docId: task.docId,
                title: task.title,
                tagIds: task.tags.map((t) => t.tagId),
                sourceType: task.sourceType,
                markdown: res.content,
            });

            task.articleId = result.articleId || task.articleId;
            if (result.status === 2) {
                task.status = "failed";
                task.error = i18n.publishReviewFailed;
            } else if (result.status === 1) {
                task.status = "success";
            } else {
                task.status = "reviewing";
            }
        } catch (e: any) {
            task.status = "failed";
            task.error = `${e?.message ?? e}`;
            logger.error("scheduled publish failed:", task.id, task.title, e);
        } finally {
            task.finishedAt = Date.now();
            this.executing.delete(task.id);
            await this.persist();
            this.notify();
        }

        if (task.status === "failed") {
            showMessage(`${i18n.scheduledPublishFailed}: ${task.title} — ${task.error}`, 9000, "error");
        } else if (task.status === "reviewing") {
            showMessage(`${i18n.scheduledPublishReviewing}: ${task.title}`);
        } else {
            showMessage(`${i18n.scheduledPublishSuccess}: ${task.title}`);
        }
    }

    private async persist(): Promise<void> {
        await this.plugin.saveData(TASKS_KEY, this.tasks);
    }
}
