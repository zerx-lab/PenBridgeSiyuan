<script lang="ts">
    import { onDestroy, onMount } from "svelte";
    import type PenBridgePlugin from "../index";
    import { PLATFORMS } from "../platforms/registry";
    import PlatformTencent from "./platform-tencent.svelte";
    import TaskList from "./task-list.svelte";

    export let plugin: PenBridgePlugin;
    /** 初始标签页：平台 id 或 "tasks" */
    export let initialTab: string = PLATFORMS[0].id;

    const i18n: any = plugin.i18n;
    const TASKS_TAB = "tasks";

    const CLOCK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.2a5.8 5.8 0 1 1 0 11.6A5.8 5.8 0 0 1 8 2.2zM8.6 4H7.3v4.58l3.54 2.12.72-1.2-2.96-1.77V4z"/>
</svg>`;

    let selectedId: string = initialTab;
    let pendingCount: number = 0;
    let unsubscribe: (() => void) | undefined;

    $: selectedPlatform = PLATFORMS.find((p) => p.id === selectedId) ?? PLATFORMS[0];

    onMount(() => {
        pendingCount = plugin.scheduler.pendingCount;
        unsubscribe = plugin.scheduler.subscribe(() => {
            pendingCount = plugin.scheduler.pendingCount;
        });
    });

    onDestroy(() => {
        unsubscribe?.();
    });
</script>

<div class="pb-settings-layout">
    <!-- 左侧导航 -->
    <nav class="pb-settings-nav b3-list b3-list--background">
        <div class="pb-settings-nav__section-label">
            {i18n.platforms}
        </div>
        {#each PLATFORMS as platform}
            <button
                class="b3-list-item pb-settings-nav__item"
                class:pb-settings-nav__item--active={selectedId === platform.id}
                on:click={() => { selectedId = platform.id; }}
            >
                <span class="pb-settings-nav__icon">{@html platform.icon}</span>
                <span class="b3-list-item__text">{i18n[platform.name] ?? platform.name}</span>
                {#if !platform.available}
                    <span class="b3-list-item__meta pb-coming-soon">{i18n.comingSoon}</span>
                {/if}
            </button>
        {/each}

        <div class="pb-settings-nav__section-label pb-settings-nav__section-label--gap">
            {i18n.manage}
        </div>
        <button
            class="b3-list-item pb-settings-nav__item"
            class:pb-settings-nav__item--active={selectedId === TASKS_TAB}
            on:click={() => { selectedId = TASKS_TAB; }}
        >
            <span class="pb-settings-nav__icon">{@html CLOCK_ICON}</span>
            <span class="b3-list-item__text">{i18n.scheduledTasks}</span>
            {#if pendingCount > 0}
                <span class="pb-nav-badge">{pendingCount}</span>
            {/if}
        </button>
    </nav>

    <!-- 右侧面板 -->
    <div class="pb-settings-panel">
        {#if selectedId === TASKS_TAB}
            <TaskList {plugin} />
        {:else if selectedPlatform.available}
            {#if selectedPlatform.id === "tencent"}
                <PlatformTencent {plugin} />
            {/if}
        {:else}
            <div class="pb-settings-placeholder">
                <span class="pb-settings-placeholder__icon">{@html selectedPlatform.icon}</span>
                <span class="pb-settings-placeholder__text">
                    {i18n[selectedPlatform.name] ?? selectedPlatform.name}
                    {i18n.comingSoon}
                </span>
            </div>
        {/if}
    </div>
</div>

<style lang="scss">
    .pb-settings-layout {
        display: flex;
        height: 100%;
        overflow: hidden;
    }

    .pb-settings-nav {
        width: 184px;
        flex-shrink: 0;
        border-right: 1px solid var(--b3-border-color);
        overflow-y: auto;
        overflow-x: hidden;
        padding: 8px;
        box-sizing: border-box;

        &__section-label {
            padding: 4px 8px 6px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            color: var(--b3-theme-on-surface-light);
            user-select: none;

            &--gap {
                margin-top: 12px;
            }
        }

        &__item {
            width: 100%;
            min-width: 0;
            max-width: 100%;
            box-sizing: border-box;
            overflow: hidden;
            text-align: left;
            border: none;
            background: transparent;
            cursor: pointer;
            display: flex;
            align-items: center;
            padding: 6px 8px;
            gap: 6px;
            /* 覆盖思源全局 .b3-list-item 的 margin: 1px 8px，避免 width:100% 叠加左右 margin 溢出 */
            margin: 0 0 2px 0;
            border-radius: var(--b3-border-radius);
            color: var(--b3-theme-on-background);
            transition: background-color 0.15s ease;

            &:hover {
                background-color: var(--b3-list-hover);
            }

            &.pb-settings-nav__item--active {
                background-color: var(--b3-theme-primary-lightest);
                color: var(--b3-theme-primary);
                font-weight: 500;

                .pb-settings-nav__icon {
                    color: var(--b3-theme-primary);
                }
            }

            :global(.b3-list-item__text) {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
        }

        &__icon {
            display: flex;
            align-items: center;
            width: 16px;
            height: 16px;
            flex-shrink: 0;
            color: var(--b3-theme-on-surface);
        }
    }

    .pb-coming-soon {
        font-size: 10px;
        color: var(--b3-theme-on-surface-light);
        white-space: nowrap;
        flex-shrink: 0;
        margin-left: auto;
    }

    .pb-nav-badge {
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        border-radius: 8px;
        font-size: 10px;
        line-height: 16px;
        text-align: center;
        box-sizing: border-box;
        background-color: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary, #fff);
        flex-shrink: 0;
        margin-left: auto;
    }

    .pb-settings-panel {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        min-width: 0;
    }

    .pb-settings-placeholder {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        gap: 12px;
        color: var(--b3-theme-on-surface-light);

        &__icon {
            display: flex;
            opacity: 0.4;
            :global(svg) {
                width: 32px;
                height: 32px;
            }
        }

        &__text {
            font-size: 14px;
        }
    }
</style>
