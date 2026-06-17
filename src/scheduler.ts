/**
 * 定时发布调度器
 * - 任务持久化到插件数据 scheduled-tasks，重启后自动恢复
 * - 30s 轮询检查到期任务；启动时立即检查一次，补发关闭期间到期的任务
 * - 上次运行中被强退的 running 任务恢复为 pending 重新执行
 * - 发布内容在任务执行时重新导出，保证发布的是文档最新内容
 */
import { showMessage, type Plugin } from "siyuan";
import { exportMdContent } from "./api";
import { runPublishJob } from "./tencent/publish";
import type { TagInfo } from "./tencent/types";
import { logger } from "./logger";

export const TASKS_KEY = "scheduled-tasks";
const TICK_MS = 30_000;

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

export class PublishScheduler {
    private plugin: Plugin;
    private tasks: ScheduledTask[] = [];
    private timer: number | undefined;
    private executing = new Set<string>();
    private listeners = new Set<() => void>();
    private checking = false;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
    }

    /** 载入持久化任务并修复中断状态（onload 调用） */
    async load(): Promise<void> {
        const data = await this.plugin.loadData(TASKS_KEY);
        this.tasks = Array.isArray(data) ? data : [];
        // 上次运行中途软件被关闭的任务恢复为待发布，等待重新执行
        let dirty = false;
        for (const task of this.tasks) {
            if (task.status === "running") {
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
        await this.execute(task);
    }

    private async checkDueTasks(): Promise<void> {
        if (this.checking) return;
        this.checking = true;
        try {
            const now = Date.now();
            const due = this.tasks.filter((t) => t.status === "pending" && t.scheduledAt <= now);
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
            const res = await exportMdContent(task.docId, { addTitle: false, yfm: false });
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
