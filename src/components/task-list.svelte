<script lang="ts">
    import { onDestroy, onMount } from "svelte";
    import type PenBridgePlugin from "../index";
    import { formatDateTime, type ScheduledTask, type TaskStatus } from "../scheduler";
    import { PLATFORMS } from "../platforms/registry";

    export let plugin: PenBridgePlugin;

    const i18n: any = plugin.i18n;

    let tasks: ScheduledTask[] = [];
    let now: number = Date.now();
    let unsubscribe: (() => void) | undefined;
    let clock: number | undefined;
    let refreshing: boolean = false;

    $: hasFinished = tasks.some((t) => t.status !== "pending" && t.status !== "running");
    $: pendingCount = tasks.filter((t) => t.status === "pending" || t.status === "running").length;

    onMount(() => {
        refresh();
        unsubscribe = plugin.scheduler.subscribe(refresh);
        // 每 30s 刷新一次「已到期」等与当前时间相关的展示
        clock = window.setInterval(() => { now = Date.now(); }, 30_000);
        // 进入页面拉取平台最新发布状态，避免审核中任务与真实状态不一致
        refreshing = true;
        plugin.scheduler.refreshStatuses().finally(() => { refreshing = false; });
    });

    onDestroy(() => {
        unsubscribe?.();
        if (clock !== undefined) window.clearInterval(clock);
    });

    function refresh() {
        tasks = plugin.scheduler.getTasks();
        now = Date.now();
    }

    function statusLabel(status: TaskStatus): string {
        const map: Record<TaskStatus, string> = {
            pending: i18n.taskStatusPending,
            running: i18n.taskStatusRunning,
            success: i18n.taskStatusSuccess,
            reviewing: i18n.taskStatusReviewing,
            failed: i18n.taskStatusFailed,
            canceled: i18n.taskStatusCanceled,
        };
        return map[status];
    }

    function platformName(id: string): string {
        const meta = PLATFORMS.find((p) => p.id === id);
        return meta ? (i18n[meta.name] ?? meta.name) : id;
    }

    function articleUrl(articleId: number): string {
        return `https://cloud.tencent.com/developer/article/${articleId}`;
    }
</script>

<div class="pb-tasks">
    <div class="pb-tasks__header">
        <div class="pb-tasks__heading">
            <span class="pb-tasks__title">{i18n.scheduledTasks}</span>
            {#if pendingCount > 0}
                <span class="pb-tasks__count">{pendingCount}</span>
            {/if}
            {#if refreshing}
                <span class="pb-tasks__refreshing">
                    <span class="pb-tasks__refreshing-spinner"></span>
                    {i18n.refreshingStatus}
                </span>
            {/if}
        </div>
        {#if hasFinished}
            <button
                class="b3-button b3-button--outline pb-btn-sm"
                on:click={() => plugin.scheduler.clearFinished()}
            >
                {i18n.clearFinished}
            </button>
        {/if}
    </div>

    {#if tasks.length === 0}
        <div class="pb-tasks__empty">
            <svg class="pb-tasks__empty-icon" viewBox="0 0 32 32">
                <path fill="currentColor" d="M16 2C8.27 2 2 8.27 2 16s6.27 14 14 14 14-6.27 14-14S23.73 2 16 2zm0 25.2C9.82 27.2 4.8 22.18 4.8 16S9.82 4.8 16 4.8 27.2 9.82 27.2 16 22.18 27.2 16 27.2zM17.4 8h-2.8v9.16l7.07 4.24 1.44-2.4-5.71-3.42V8z"/>
            </svg>
            <div class="pb-tasks__empty-title">{i18n.noTasks}</div>
            <div class="pb-tasks__empty-hint b3-label__text">{i18n.noTasksHint}</div>
        </div>
    {:else}
        <ul class="pb-tasks__list">
            {#each tasks as task (task.id)}
                <li class="pb-task" class:pb-task--done={task.status === "success" || task.status === "canceled"}>
                    <div class="pb-task__main">
                        <div class="pb-task__row">
                            <span class="pb-task__name" title={task.title}>{task.title}</span>
                            <span class="pb-task-badge pb-task-badge--{task.status}">
                                {#if task.status === "running"}
                                    <span class="pb-task-badge__spinner"></span>
                                {/if}
                                {statusLabel(task.status)}
                            </span>
                        </div>
                        <div class="pb-task__meta b3-label__text">
                            <span title={i18n.taskScheduledAt}>
                                🕐 {formatDateTime(task.scheduledAt)}
                                {#if task.status === "pending" && task.scheduledAt <= now}
                                    <span class="pb-task__overdue">{i18n.taskOverdue}</span>
                                {/if}
                            </span>
                            <span class="pb-task__dot">·</span>
                            <span>{platformName(task.platformId)}</span>
                            {#if task.tags.length > 0}
                                <span class="pb-task__dot">·</span>
                                <span class="pb-task__tags" title={task.tags.map((t) => t.tagName).join(", ")}>
                                    {task.tags.map((t) => t.tagName).join(" / ")}
                                </span>
                            {/if}
                        </div>
                        {#if task.error}
                            <div class="pb-task__error" title={task.error}>{task.error}</div>
                        {/if}
                        {#if (task.status === "success" || task.status === "reviewing") && task.articleId}
                            <div class="pb-task__result b3-label__text">
                                {i18n.taskFinishedAt}: {formatDateTime(task.finishedAt)}
                                <a href={articleUrl(task.articleId)} target="_blank" rel="noreferrer">{i18n.viewArticle}</a>
                            </div>
                        {/if}
                    </div>
                    <div class="pb-task__actions">
                        {#if task.status === "pending"}
                            <button class="b3-button b3-button--text pb-btn-sm" on:click={() => plugin.scheduler.runNow(task.id)}>
                                {i18n.runNow}
                            </button>
                            <button class="b3-button b3-button--outline pb-btn-sm" on:click={() => plugin.scheduler.cancelTask(task.id)}>
                                {i18n.cancelTask}
                            </button>
                        {:else if task.status === "failed"}
                            <button class="b3-button b3-button--text pb-btn-sm" on:click={() => plugin.scheduler.runNow(task.id)}>
                                {i18n.retryTask}
                            </button>
                            <button class="b3-button b3-button--outline pb-btn-sm" on:click={() => plugin.scheduler.deleteTask(task.id)}>
                                {i18n.deleteTask}
                            </button>
                        {:else if task.status !== "running"}
                            <button class="b3-button b3-button--outline pb-btn-sm" on:click={() => plugin.scheduler.deleteTask(task.id)}>
                                {i18n.deleteTask}
                            </button>
                        {/if}
                    </div>
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style lang="scss">
    .pb-tasks {
        display: flex;
        flex-direction: column;
        height: 100%;
        padding: 16px 20px;
        overflow: hidden;
        box-sizing: border-box;

        &__header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 12px;
            flex-shrink: 0;
        }

        &__heading {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        &__title {
            font-size: 14px;
            font-weight: 600;
            color: var(--b3-theme-on-background);
        }

        &__count {
            min-width: 18px;
            height: 18px;
            padding: 0 5px;
            border-radius: 9px;
            font-size: 11px;
            line-height: 18px;
            text-align: center;
            box-sizing: border-box;
            background-color: var(--b3-theme-primary);
            color: var(--b3-theme-on-primary, #fff);
        }

        &__refreshing {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            font-size: 11px;
            color: var(--b3-theme-on-surface-light);
        }

        &__refreshing-spinner {
            width: 10px;
            height: 10px;
            border: 1.5px solid currentColor;
            border-top-color: transparent;
            border-radius: 50%;
            animation: pb-spin 0.8s linear infinite;
        }

        &__list {
            flex: 1;
            margin: 0;
            padding: 0;
            list-style: none;
            overflow-y: auto;
            min-height: 0;
        }

        &__empty {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 8px;
            color: var(--b3-theme-on-surface-light);

            &-icon {
                width: 32px;
                height: 32px;
                opacity: 0.4;
            }

            &-title {
                font-size: 14px;
            }

            &-hint {
                font-size: 12px;
            }
        }
    }

    .pb-task {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 10px 12px;
        margin-bottom: 8px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background-color: var(--b3-theme-background);
        transition: border-color 0.15s ease;

        &:hover {
            border-color: var(--b3-theme-primary-light, var(--b3-theme-primary));
        }

        &--done {
            opacity: 0.75;
        }

        &__main {
            flex: 1;
            min-width: 0;
        }

        &__row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 4px;
        }

        &__name {
            font-weight: 500;
            color: var(--b3-theme-on-background);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            min-width: 0;
        }

        &__meta {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 4px;
            font-size: 12px;
        }

        &__dot {
            opacity: 0.5;
        }

        &__tags {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 220px;
        }

        &__overdue {
            margin-left: 4px;
            color: var(--b3-card-warning-color, #bf8700);
        }

        &__error {
            margin-top: 4px;
            font-size: 12px;
            color: var(--b3-theme-error);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        &__result {
            margin-top: 4px;
            font-size: 12px;

            a {
                margin-left: 6px;
                color: var(--b3-theme-primary);
            }
        }

        &__actions {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
        }
    }

    .pb-task-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 7px;
        font-size: 11px;
        line-height: 18px;
        border-radius: 9px;
        white-space: nowrap;
        flex-shrink: 0;
        border: 1px solid transparent;

        &--pending {
            color: var(--b3-theme-primary);
            border-color: var(--b3-theme-primary);
            background-color: rgba(53, 115, 240, 0.08);
        }

        &--running {
            color: var(--b3-theme-primary);
            border-color: var(--b3-theme-primary);
            background-color: rgba(53, 115, 240, 0.08);
        }

        &--success {
            color: var(--b3-card-success-color, #2da44e);
            border-color: var(--b3-card-success-color, #2da44e);
            background-color: var(--b3-card-success-background, rgba(45, 164, 78, 0.08));
        }

        &--reviewing {
            color: var(--b3-card-warning-color, #bf8700);
            border-color: var(--b3-card-warning-color, #bf8700);
            background-color: var(--b3-card-warning-background, rgba(191, 135, 0, 0.08));
        }

        &--failed {
            color: var(--b3-theme-error);
            border-color: var(--b3-theme-error);
            background-color: var(--b3-card-error-background, rgba(217, 48, 37, 0.08));
        }

        &--canceled {
            color: var(--b3-theme-on-surface-light);
            border-color: var(--b3-border-color);
            background-color: var(--b3-theme-surface);
        }

        &__spinner {
            width: 10px;
            height: 10px;
            border: 1.5px solid currentColor;
            border-top-color: transparent;
            border-radius: 50%;
            animation: pb-spin 0.8s linear infinite;
        }
    }

    @keyframes pb-spin {
        to {
            transform: rotate(360deg);
        }
    }
</style>
