<script lang="ts">
    import { showMessage } from "siyuan";
    import type PenBridgePlugin from "../index";
    import { TencentClient } from "../tencent/client";
    import { extractPlainText } from "../tencent/markdown";
    import { runPublishJob, PublishError } from "../tencent/publish";
    import { formatDateTime } from "../scheduler";
    import type { TagInfo, TencentConfig } from "../tencent/types";
    import { logger } from "../logger";

    export let plugin: PenBridgePlugin;
    export let docId: string;
    export let defaultTitle: string = "";
    export let markdown: string = "";
    export let onClose: () => void = () => {};

    const i18n: any = plugin.i18n;
    const MAX_TAGS = 5;

    let title: string = defaultTitle;
    let sourceType: number = 1;
    let keyword: string = "";
    let searching: boolean = false;
    let searched: boolean = false;
    let searchResults: TagInfo[] = [];
    let selectedTags: TagInfo[] = [];
    let publishing: boolean = false;
    let uploadProgress: { done: number; total: number } | null = null;

    /* 发布方式：立即 / 定时 */
    let mode: "now" | "later" = "now";
    let scheduleValue: string = toLocalInputValue(Date.now() + 60 * 60_000);

    $: scheduleMs = scheduleValue ? new Date(scheduleValue).getTime() : NaN;
    $: scheduleInvalid = mode === "later" && (!Number.isFinite(scheduleMs) || scheduleMs <= Date.now());

    const plain = extractPlainText(markdown);

    function toLocalInputValue(ms: number): string {
        const d = new Date(ms);
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    /** 快捷预设：1 小时后 / 今晚 20:00（已过则明晚）/ 明早 9:00 */
    function applyPreset(preset: "in1h" | "tonight" | "tomorrow") {
        const now = new Date();
        if (preset === "in1h") {
            scheduleValue = toLocalInputValue(Date.now() + 60 * 60_000);
            return;
        }
        const target = new Date(now);
        if (preset === "tonight") {
            target.setHours(20, 0, 0, 0);
            if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
        } else {
            target.setDate(target.getDate() + 1);
            target.setHours(9, 0, 0, 0);
        }
        scheduleValue = toLocalInputValue(target.getTime());
    }

    async function getClient(): Promise<TencentClient | null> {
        const config = (await plugin.loadData("tencent-config")) as TencentConfig;
        if (!config || typeof config !== "object" || !config.cookie) {
            showMessage(i18n.needCookie, 6000, "error");
            return null;
        }
        return new TencentClient(config.cookie);
    }

    async function doSearch() {
        const kw = keyword.trim();
        if (!kw || searching) return;
        searching = true;
        try {
            const client = await getClient();
            if (!client) return;
            searchResults = await client.searchTags(kw);
            searched = true;
        } catch (e: any) {
            showMessage(`${i18n.searchTags}: ${e?.message ?? e}`, 6000, "error");
        } finally {
            searching = false;
        }
    }

    function addTag(tag: TagInfo) {
        if (selectedTags.length >= MAX_TAGS) {
            showMessage(i18n.tagsHint);
            return;
        }
        if (selectedTags.some((t) => t.tagId === tag.tagId)) return;
        selectedTags = [...selectedTags, tag];
    }

    function removeTag(tag: TagInfo) {
        selectedTags = selectedTags.filter((t) => t.tagId !== tag.tagId);
    }

    /** 前置校验，立即发布与定时发布共用 */
    function validateInputs(): boolean {
        const t = title.trim();
        if (!t) {
            showMessage(i18n.titleRequired, 6000, "error");
            return false;
        }
        if (t.length > 80) {
            showMessage(i18n.titleTooLong, 6000, "error");
            return false;
        }
        if (plain.length < 140) {
            showMessage(i18n.plainTooShort, 6000, "error");
            return false;
        }
        if (selectedTags.length < 1 || selectedTags.length > MAX_TAGS) {
            showMessage(i18n.tagsRequired, 6000, "error");
            return false;
        }
        return true;
    }

    function submit() {
        if (mode === "later") {
            void schedule();
        } else {
            void publish();
        }
    }

    async function schedule() {
        if (!validateInputs()) return;
        if (!Number.isFinite(scheduleMs) || scheduleMs <= Date.now()) {
            showMessage(i18n.scheduleTimeInvalid, 6000, "error");
            return;
        }
        try {
            await plugin.scheduler.addTask({
                platformId: "tencent",
                docId,
                title: title.trim(),
                tags: selectedTags,
                sourceType,
                scheduledAt: scheduleMs,
            });
            showMessage(i18n.scheduleCreated.replace("${time}", formatDateTime(scheduleMs)));
            onClose();
        } catch (e: any) {
            logger.error("schedule task failed:", e);
            showMessage(`${i18n.publishFailed}: ${e?.message ?? e}`, 6000, "error");
        }
    }

    async function publish() {
        if (!validateInputs()) return;

        publishing = true;
        uploadProgress = null;
        try {
            const result = await runPublishJob(plugin, {
                docId,
                title: title.trim(),
                tagIds: selectedTags.map((tag) => tag.tagId),
                sourceType,
                markdown,
                onUploadProgress: (done, total) => {
                    uploadProgress = { done, total };
                },
            });
            uploadProgress = null;

            if (result.status === 1) {
                showMessage(i18n.publishSuccess);
            } else if (result.status === 0) {
                showMessage(i18n.publishPending);
            } else if (result.status === 2) {
                showMessage(`${i18n.publishFailed}: ${i18n.publishReviewFailed}`, 9000, "error");
            } else {
                showMessage(i18n.publishFailed, 6000, "error");
            }
            onClose();
        } catch (e: any) {
            const stage = e instanceof PublishError ? e.stage : undefined;
            const stageLabel =
                stage === "uploadImages"
                    ? i18n.stageUploadImages
                    : stage === "draft"
                    ? i18n.stageDraft
                    : stage === "publish"
                    ? i18n.stagePublish
                    : "";
            logger.error("publish failed at stage:", stage ?? "unknown", e);
            const prefix = stageLabel ? `${i18n.publishFailed} [${stageLabel}]` : i18n.publishFailed;
            showMessage(`${prefix}: ${e?.message ?? e}`, 9000, "error");
        } finally {
            publishing = false;
            uploadProgress = null;
        }
    }
</script>

<div class="pb-publish">
    <div class="b3-dialog__content">
        <!-- 标题 -->
        <div class="pb-field">
            <label class="pb-field__label" for="pb-title">
                {i18n.title}
                <span class="b3-label__text">（{i18n.titleHint}）</span>
            </label>
            <input
                id="pb-title"
                class="b3-text-field fn__block"
                class:pb-invalid={title.trim().length > 80}
                bind:value={title}
            />
        </div>

        <!-- 标签 -->
        <div class="pb-field">
            <label class="pb-field__label" for="pb-tag-search">
                {i18n.tags}
                <span class="b3-label__text">（{i18n.tagsHint}）</span>
            </label>
            {#if selectedTags.length > 0}
                <div class="pb-tag-chips">
                    {#each selectedTags as tag (tag.tagId)}
                        <span
                            class="pb-tag-chip"
                            role="button"
                            tabindex="0"
                            title={i18n.cancel}
                            on:click={() => removeTag(tag)}
                            on:keydown={(e) => e.key === "Enter" && removeTag(tag)}
                        >
                            {tag.tagName}
                            <svg class="pb-tag-chip__close"><use xlink:href="#iconClose"></use></svg>
                        </span>
                    {/each}
                </div>
            {/if}
            <div class="fn__flex">
                <input
                    id="pb-tag-search"
                    class="b3-text-field fn__flex-1"
                    placeholder={i18n.searchTags}
                    bind:value={keyword}
                    on:keydown={(e) => e.key === "Enter" && doSearch()}
                />
                <span class="fn__space"></span>
                <button class="b3-button b3-button--outline" disabled={searching} on:click={doSearch}>
                    {searching ? i18n.searching : i18n.searchTags}
                </button>
            </div>
            {#if searchResults.length > 0}
                <ul class="pb-tag-results b3-list b3-list--background">
                    {#each searchResults as tag (tag.tagId)}
                        <!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role -->
                        <li
                            class="b3-list-item pb-tag-result"
                            class:pb-tag-result--selected={selectedTags.some((t) => t.tagId === tag.tagId)}
                            role="button"
                            tabindex="0"
                            on:click={() => addTag(tag)}
                            on:keydown={(e) => e.key === "Enter" && addTag(tag)}
                        >
                            <span class="b3-list-item__text">{tag.tagName}</span>
                        </li>
                    {/each}
                </ul>
            {:else if searched && !searching}
                <div class="b3-label__text pb-no-result">{i18n.noTagsFound}</div>
            {/if}
        </div>

        <!-- 来源 -->
        <div class="pb-field">
            <label class="pb-field__label" for="pb-source-type">{i18n.sourceType}</label>
            <select id="pb-source-type" class="b3-select fn__block" bind:value={sourceType}>
                <option value={1}>{i18n.original}</option>
                <option value={2}>{i18n.reprint}</option>
                <option value={3}>{i18n.translation}</option>
            </select>
        </div>

        <!-- 发布方式 -->
        <div class="pb-field">
            <span class="pb-field__label">{i18n.publishMode}</span>
            <div class="pb-mode-switch" role="radiogroup" aria-label={i18n.publishMode}>
                <button
                    class="pb-mode-switch__option"
                    class:pb-mode-switch__option--active={mode === "now"}
                    role="radio"
                    aria-checked={mode === "now"}
                    on:click={() => { mode = "now"; }}
                >
                    {i18n.publishNow}
                </button>
                <button
                    class="pb-mode-switch__option"
                    class:pb-mode-switch__option--active={mode === "later"}
                    role="radio"
                    aria-checked={mode === "later"}
                    on:click={() => { mode = "later"; }}
                >
                    {i18n.publishLater}
                </button>
            </div>
            {#if mode === "later"}
                <div class="pb-schedule">
                    <div class="pb-schedule__row">
                        <input
                            type="datetime-local"
                            class="b3-text-field pb-schedule__input"
                            class:pb-invalid={scheduleInvalid}
                            min={toLocalInputValue(Date.now())}
                            bind:value={scheduleValue}
                        />
                        <div class="pb-schedule__presets">
                            <button class="pb-schedule__preset" on:click={() => applyPreset("in1h")}>
                                {i18n.presetIn1Hour}
                            </button>
                            <button class="pb-schedule__preset" on:click={() => applyPreset("tonight")}>
                                {i18n.presetTonight}
                            </button>
                            <button class="pb-schedule__preset" on:click={() => applyPreset("tomorrow")}>
                                {i18n.presetTomorrowMorning}
                            </button>
                        </div>
                    </div>
                    {#if scheduleInvalid}
                        <div class="pb-warning pb-schedule__warning">{i18n.scheduleTimeInvalid}</div>
                    {:else}
                        <div class="b3-label__text pb-schedule__hint">{i18n.scheduleHint}</div>
                    {/if}
                </div>
            {/if}
        </div>

        <!-- 字数 -->
        <div class="pb-field">
            <span class="b3-label__text">
                {i18n.wordCount}: {plain.length}
                {#if plain.length < 140}
                    <span class="pb-warning">⚠ {i18n.plainTooShort}</span>
                {/if}
            </span>
        </div>
    </div>

    <div class="b3-dialog__action">
        <button class="b3-button b3-button--cancel" on:click={() => onClose()}>
            {i18n.cancel}
        </button>
        <div class="fn__space"></div>
        <button
            class="b3-button b3-button--text"
            disabled={publishing || (mode === "later" && scheduleInvalid)}
            on:click={submit}
        >
            {#if uploadProgress}
                {i18n.uploadingImages.replace("${done}", String(uploadProgress.done)).replace("${total}", String(uploadProgress.total))}
            {:else if publishing}
                {i18n.publishing}
            {:else if mode === "later"}
                {i18n.createScheduledTask}
            {:else}
                {i18n.publish}
            {/if}
        </button>
    </div>
</div>

<style lang="scss">
    .pb-mode-switch {
        display: inline-flex;
        padding: 2px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background-color: var(--b3-theme-surface);
        gap: 2px;

        &__option {
            border: none;
            background: transparent;
            cursor: pointer;
            padding: 4px 16px;
            font-size: 13px;
            line-height: 20px;
            border-radius: calc(var(--b3-border-radius) - 2px);
            color: var(--b3-theme-on-surface);
            transition: background-color 0.15s ease, color 0.15s ease;

            &:hover {
                color: var(--b3-theme-on-background);
            }

            &--active {
                background-color: var(--b3-theme-background);
                color: var(--b3-theme-primary);
                font-weight: 500;
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
            }
        }
    }

    .pb-schedule {
        margin-top: 10px;

        &__row {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 8px;
        }

        &__input {
            width: 220px;
        }

        &__presets {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        &__preset {
            border: 1px solid var(--b3-border-color);
            background-color: transparent;
            cursor: pointer;
            padding: 3px 10px;
            font-size: 12px;
            line-height: 18px;
            border-radius: 12px;
            color: var(--b3-theme-on-surface);
            transition: border-color 0.15s ease, color 0.15s ease;

            &:hover {
                border-color: var(--b3-theme-primary);
                color: var(--b3-theme-primary);
            }
        }

        &__warning,
        &__hint {
            margin-top: 6px;
            font-size: 12px;
        }
    }
</style>
