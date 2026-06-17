<script lang="ts">
    import { onMount } from "svelte";
    import { showMessage, type Plugin } from "siyuan";
    import { TencentClient } from "../tencent/client";
    import type { TencentConfig } from "../tencent/types";
    import { canUseBrowserLogin, loginViaBrowserWindow } from "../tencent/browserLogin";

    export let plugin: Plugin;

    const i18n: any = plugin.i18n;

    let cookie: string = "";
    let verifying: boolean = false;
    let browserLogging: boolean = false;
    let config: TencentConfig | null = null;

    onMount(async () => {
        const data = await plugin.loadData("tencent-config");
        if (data && typeof data === "object" && data.cookie) {
            config = data as TencentConfig;
            cookie = config.cookie;
        }
    });

    function formatTime(ts?: number): string {
        if (!ts) return "-";
        return new Date(ts).toLocaleString();
    }

    async function handleBrowserLogin() {
        browserLogging = true;
        try {
            const cookieStr = await loginViaBrowserWindow();
            cookie = cookieStr;
            await verify();
        } catch (e: any) {
            if (e?.message === "login cancelled") {
                showMessage(i18n.loginCancelled, 4000);
            } else if (e?.message === "login timeout") {
                showMessage(i18n.loginTimeout, 6000, "error");
            } else {
                showMessage(`${i18n.verifyFailed}: ${e?.message ?? e}`, 6000, "error");
            }
        } finally {
            browserLogging = false;
        }
    }

    async function verify() {
        const trimmed = cookie.trim();
        if (!trimmed) {
            showMessage(i18n.needCookie, 6000, "error");
            return;
        }
        verifying = true;
        try {
            const client = new TencentClient(trimmed);
            await client.verifyAuth();
            config = {
                cookie: trimmed,
                verifiedAt: Date.now(),
            };
            await plugin.saveData("tencent-config", config);
            showMessage(i18n.verified);
        } catch (e: any) {
            showMessage(`${i18n.verifyFailed}: ${e?.message ?? e}`, 6000, "error");
        } finally {
            verifying = false;
        }
    }
</script>

<div class="pb-tencent-panel">
    <div class="pb-tencent-panel__header">
        <span class="pb-tencent-panel__title">{i18n.platformTencent}</span>
        {#if config?.cookie}
            <span class="pb-badge pb-badge--ok">{i18n.configured}</span>
        {:else}
            <span class="pb-badge">{i18n.notConfigured}</span>
        {/if}
    </div>

    <div class="b3-label__text pb-tencent-panel__desc">
        {i18n.cookiePlaceholder}
    </div>

    <textarea
        class="b3-text-field fn__block pb-cookie-input"
        rows="5"
        placeholder={i18n.cookiePlaceholder}
        bind:value={cookie}
    ></textarea>

    <div class="pb-tencent-panel__footer">
        <span class="pb-tencent-panel__status b3-label__text">
            {#if config?.verifiedAt}
                {i18n.lastVerified}: {formatTime(config.verifiedAt)}
            {/if}
        </span>
        <div class="pb-tencent-panel__actions">
            {#if canUseBrowserLogin()}
                <button
                    class="b3-button b3-button--outline pb-btn-sm"
                    disabled={verifying || browserLogging}
                    on:click={handleBrowserLogin}
                >
                    {browserLogging ? i18n.loggingIn : i18n.browserLogin}
                </button>
            {/if}
            <button
                class="b3-button b3-button--text pb-btn-sm"
                disabled={verifying || browserLogging}
                on:click={verify}
            >
                {verifying ? i18n.verifying : i18n.verify}
            </button>
        </div>
    </div>
</div>

<style lang="scss">
    .pb-tencent-panel {
        display: flex;
        flex-direction: column;
        height: 100%;
        padding: 16px 20px;
        overflow-y: auto;
        box-sizing: border-box;

        &__header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
        }

        &__title {
            font-size: 14px;
            font-weight: 600;
            color: var(--b3-theme-on-background);
        }

        &__desc {
            margin-bottom: 10px;
            line-height: 1.5;
        }

        &__footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-top: 10px;
            gap: 8px;
        }

        &__status {
            flex: 1;
            font-size: 12px;
            min-width: 0;
        }

        &__actions {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
        }
    }

    .pb-cookie-input {
        resize: vertical;
        font-family: var(--b3-font-family-code);
        font-size: 12px;
    }

    .pb-badge {
        display: inline-block;
        padding: 1px 7px;
        font-size: 11px;
        line-height: 18px;
        border-radius: 9px;
        background-color: var(--b3-theme-surface);
        color: var(--b3-theme-on-surface-light);
        border: 1px solid var(--b3-border-color);

        &--ok {
            background-color: rgba(var(--b3-theme-primary-rgb, 84, 130, 53), 0.12);
            color: var(--b3-theme-primary);
            border-color: var(--b3-theme-primary);
        }
    }
</style>
