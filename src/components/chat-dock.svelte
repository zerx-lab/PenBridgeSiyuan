<script lang="ts">
    import { onMount, onDestroy } from "svelte";
    import { showMessage, confirm } from "siyuan";
    import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
    import { getProviders, getModels, type KnownProvider } from "@earendil-works/pi-ai";
    import type PenBridgePlugin from "../index";
    import { createSiyuanAgent, type ConfirmRequest } from "../ai/session";
    import { AI_CONFIG_KEY, DEFAULT_AGENT_CONFIG, type AgentConfig } from "../ai/config";
    import { type ChatSession, SESSIONS_KEY } from "../ai/history";
    import { getActiveProtyle } from "../active-doc";
    import { getHPathByID, getBlockKramdown } from "../api";
    import { logger } from "../logger";
    import { diffLines } from "diff";

    export let plugin: PenBridgePlugin;
    const i18n = plugin.i18n as Record<string, string>;

    type ToolCall = { name: string; args: string };
    type ChatEntry =
        | { kind: "user"; text: string }
        | { kind: "assistant"; text: string; tools: ToolCall[] }
        | { kind: "tool"; name: string; text: string; isError: boolean };

    interface QueueItem {
        id: string;
        text: string;
    }

    type DiffPart = { type: "add" | "del" | "same"; text: string };
    interface PendingConfirm {
        toolName: string;
        summary: string;
        diff: DiffPart[];
        resolve: (ok: boolean) => void;
    }

    let config: AgentConfig = { ...DEFAULT_AGENT_CONFIG };
    let providers: string[] = [];
    let models: { id: string; name: string }[] = [];
    let configured = false;
    let showConfig = false;
    let showHistory = false;

    let agent: Agent | undefined;
    let unsub: (() => void) | undefined;
    let entries: ChatEntry[] = [];
    let input = "";
    let running = false;
    let queue: QueueItem[] = [];
    let activeTool: ToolCall | null = null;
    let runToken = 0;
    let listEl: HTMLDivElement | undefined;

    let yolo = false;
    let autoApprove: Record<string, true> = {};
    let pendingConfirm: PendingConfirm | null = null;

    let sessions: ChatSession[] = [];
    let currentSessionId: string = crypto.randomUUID();

    onMount(async () => {
        providers = getProviders();
        const savedConfig = await plugin.loadData(AI_CONFIG_KEY);
        if (savedConfig && typeof savedConfig === "object") {
            const c = savedConfig as Partial<AgentConfig>;
            config = {
                provider: c.provider ?? DEFAULT_AGENT_CONFIG.provider,
                model: c.model ?? "",
                apiKey: c.apiKey ?? "",
                baseUrl: c.baseUrl ?? "",
                systemPrompt: c.systemPrompt ?? "",
            };
        }
        const savedSessions = await plugin.loadData(SESSIONS_KEY);
        if (Array.isArray(savedSessions)) sessions = savedSessions as ChatSession[];
        refreshModels();
        configured = Boolean(config.apiKey && config.model);
        showConfig = !configured;
    });

    onDestroy(() => {
        unsub?.();
        agent?.abort();
    });

    function refreshModels() {
        try {
            models = getModels(config.provider as KnownProvider).map((m) => ({ id: m.id, name: m.name }));
        } catch {
            models = [];
        }
        if (!models.some((m) => m.id === config.model)) {
            config.model = models[0]?.id ?? "";
        }
    }

    async function saveConfig() {
        config.apiKey = config.apiKey.trim();
        config.baseUrl = config.baseUrl.trim();
        if (!config.provider || !config.model || !config.apiKey) {
            showMessage(i18n.aiNeedConfig, 5000, "error");
            return;
        }
        await plugin.saveData(AI_CONFIG_KEY, config);
        configured = true;
        showConfig = false;
        resetAgent();
        showMessage(i18n.aiConfigSaved);
    }

    function resetAgent() {
        runToken++;
        unsub?.();
        agent?.abort();
        pendingConfirm?.resolve(false);
        pendingConfirm = null;
        autoApprove = {};
        agent = undefined;
        unsub = undefined;
        entries = [];
        queue = [];
        activeTool = null;
        running = false;
    }

    function computeDiff(before: string, after: string): DiffPart[] {
        const out: DiffPart[] = [];
        for (const part of diffLines(before, after)) {
            const type = part.added ? "add" : part.removed ? "del" : "same";
            for (const line of part.value.replace(/\n$/, "").split("\n")) {
                out.push({ type, text: line });
            }
        }
        return out;
    }

    async function buildPending(req: ConfirmRequest): Promise<Omit<PendingConfirm, "resolve">> {
        const a = (req.args ?? {}) as Record<string, unknown>;
        const str = (v: unknown): string => (typeof v === "string" ? v : "");
        switch (req.toolName) {
            case "update_block": {
                const blockId = str(a.blockId);
                let before = "";
                try {
                    before = (await getBlockKramdown(blockId)).kramdown ?? "";
                } catch {
                    // 读不到旧内容则按纯新增展示
                }
                return { toolName: req.toolName, summary: `update_block ${blockId}`, diff: computeDiff(before, str(a.markdown)) };
            }
            case "append_block":
                return { toolName: req.toolName, summary: `append_block → ${str(a.parentId)}`, diff: computeDiff("", str(a.markdown)) };
            case "insert_block":
                return { toolName: req.toolName, summary: "insert_block", diff: computeDiff("", str(a.markdown)) };
            case "create_document":
                return { toolName: req.toolName, summary: `create_document ${str(a.path)}`, diff: computeDiff("", str(a.markdown)) };
            case "delete_block":
                return { toolName: req.toolName, summary: `delete_block ${str(a.blockId)}`, diff: [] };
            case "siyuan_api":
                return {
                    toolName: req.toolName,
                    summary: `siyuan_api → ${str(a.endpoint)}`,
                    diff: computeDiff("", JSON.stringify(a.payload ?? {}, null, 2)),
                };
            default:
                return { toolName: req.toolName, summary: req.toolName, diff: [] };
        }
    }

    async function confirmWrite(req: ConfirmRequest): Promise<boolean> {
        if (yolo) return true;
        if (autoApprove[req.toolName]) return true;
        const pending = await buildPending(req);
        return new Promise<boolean>((resolve) => {
            pendingConfirm = { ...pending, resolve };
        });
    }

    function approve(ok: boolean) {
        pendingConfirm?.resolve(ok);
        pendingConfirm = null;
    }

    function approveAll() {
        const p = pendingConfirm;
        if (!p) return;
        autoApprove = { ...autoApprove, [p.toolName]: true };
        p.resolve(true);
        pendingConfirm = null;
    }

    async function ensureAgent(initialMessages?: AgentMessage[]): Promise<Agent> {
        if (agent) return agent;
        const protyle = getActiveProtyle();
        let activeDoc;
        const docId = protyle?.block?.rootID;
        if (docId) {
            let hpath = "";
            try {
                hpath = await getHPathByID(docId);
            } catch {
                // hpath 可选
            }
            activeDoc = { docId, title: hpath ? hpath.split("/").pop() ?? "" : "", hpath };
        }
        const created = createSiyuanAgent({ config, activeDoc, messages: initialMessages, confirmWrite });
        unsub = created.subscribe((event) => {
            if (event.type === "tool_execution_start") {
                activeTool = { name: event.toolName, args: stringify(event.args) };
            } else if (event.type === "tool_execution_end") {
                activeTool = null;
            }
            rebuild();
        });
        agent = created;
        return created;
    }

    function stringify(value: unknown): string {
        if (value === undefined || value === null) return "";
        if (typeof value === "string") return value;
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    }

    function blockText(content: unknown): string {
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        let out = "";
        for (const b of content) {
            if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
                const t = (b as { text?: unknown }).text;
                if (typeof t === "string") out += t;
            }
        }
        return out;
    }

    function toolCalls(content: unknown): ToolCall[] {
        if (!Array.isArray(content)) return [];
        const out: ToolCall[] = [];
        for (const b of content) {
            if (b && typeof b === "object" && (b as { type?: unknown }).type === "toolCall") {
                const o = b as { name?: unknown; arguments?: unknown };
                out.push({ name: typeof o.name === "string" ? o.name : "", args: stringify(o.arguments) });
            }
        }
        return out;
    }

    function buildEntries(messages: unknown[]): ChatEntry[] {
        const out: ChatEntry[] = [];
        for (const m of messages) {
            if (!m || typeof m !== "object") continue;
            const msg = m as { role?: string; content?: unknown; toolName?: unknown; isError?: unknown };
            if (msg.role === "user") {
                const text = blockText(msg.content);
                if (text) out.push({ kind: "user", text });
            } else if (msg.role === "assistant") {
                out.push({ kind: "assistant", text: blockText(msg.content), tools: toolCalls(msg.content) });
            } else if (msg.role === "toolResult") {
                out.push({
                    kind: "tool",
                    name: typeof msg.toolName === "string" ? msg.toolName : "",
                    text: blockText(msg.content),
                    isError: msg.isError === true,
                });
            }
        }
        return out;
    }

    function deriveTitle(messages: AgentMessage[]): string {
        for (const m of messages) {
            const msg = m as { role?: string; content?: unknown };
            if (msg.role === "user") {
                const text = blockText(msg.content).trim();
                if (text) return text.length > 28 ? `${text.slice(0, 28)}…` : text;
            }
        }
        return i18n.aiUntitled;
    }

    function persistSession() {
        if (!agent) return;
        const messages = agent.state.messages;
        if (messages.length === 0) return;
        const session: ChatSession = {
            id: currentSessionId,
            title: deriveTitle(messages),
            messages,
            updatedAt: Date.now(),
        };
        const idx = sessions.findIndex((s) => s.id === currentSessionId);
        if (idx >= 0) {
            sessions[idx] = session;
            sessions = [...sessions];
        } else {
            sessions = [session, ...sessions];
        }
        void plugin.saveData(SESSIONS_KEY, sessions);
    }

    function rebuild() {
        const a = agent;
        if (!a) return;
        const msgs = a.state.messages.slice();
        if (a.state.streamingMessage) msgs.push(a.state.streamingMessage);
        entries = buildEntries(msgs);
        queueMicrotask(() => listEl?.scrollTo({ top: listEl.scrollHeight }));
    }

    /** 串行处理消息；用 runToken 隔离，stopAll 递增令牌使旧循环安全失效。 */
    async function drain(firstText: string) {
        const token = ++runToken;
        running = true;
        let next: string | undefined = firstText;
        try {
            while (next !== undefined && token === runToken) {
                try {
                    const a = await ensureAgent();
                    await a.prompt(next);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (!/abort/i.test(msg)) {
                        logger.error("agent prompt failed:", e);
                        showMessage(`${i18n.aiError}: ${msg}`, 6000, "error");
                    }
                }
                if (token !== runToken) break;
                rebuild();
                persistSession();
                if (queue.length > 0) {
                    next = queue[0].text;
                    queue = queue.slice(1);
                } else {
                    next = undefined;
                }
            }
        } finally {
            if (token === runToken) {
                running = false;
                activeTool = null;
                rebuild();
            }
        }
    }

    function send() {
        const text = input.trim();
        if (!text) return;
        input = "";
        if (running) {
            queue = [...queue, { id: crypto.randomUUID(), text }];
        } else {
            void drain(text);
        }
    }

    /** 立刻发送队列项：running 时用 steer 打断当前消息，否则直接处理。 */
    function sendNow(item: QueueItem) {
        queue = queue.filter((q) => q.id !== item.id);
        if (running && agent) {
            agent.steer({ role: "user", content: item.text, timestamp: Date.now() });
        } else {
            void drain(item.text);
        }
    }

    function removeQueued(id: string) {
        queue = queue.filter((q) => q.id !== id);
    }

    /** 强制停止：递增 runToken 让当前 drain 失效，立即恢复 UI。 */
    function stopAll() {
        runToken++;
        queue = [];
        pendingConfirm?.resolve(false);
        pendingConfirm = null;
        agent?.abort();
        activeTool = null;
        running = false;
    }

    function onKeydown(e: KeyboardEvent) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    }

    function onPanelKeydown(e: KeyboardEvent) {
        // Ctrl/⌘+N：新建会话；拦截思源在 window 冒泡阶段监听的"新建文档"快捷键
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "n" || e.key === "N")) {
            e.preventDefault();
            e.stopPropagation();
            newChat();
        }
    }

    function newChat() {
        resetAgent();
        currentSessionId = crypto.randomUUID();
        showHistory = false;
    }

    async function switchSession(s: ChatSession) {
        resetAgent();
        currentSessionId = s.id;
        try {
            await ensureAgent(s.messages);
            rebuild();
        } catch (e) {
            showMessage(`${i18n.aiError}: ${e instanceof Error ? e.message : String(e)}`, 6000, "error");
        }
        showHistory = false;
    }

    function deleteSession(s: ChatSession, e: Event) {
        e.stopPropagation();
        confirm(i18n.aiDeleteTitle, `${i18n.aiDeleteConfirm}\n\n${s.title}`, () => {
            sessions = sessions.filter((x) => x.id !== s.id);
            void plugin.saveData(SESSIONS_KEY, sessions);
            if (s.id === currentSessionId) newChat();
        });
    }

    function onHistoryKey(e: KeyboardEvent, s: ChatSession) {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void switchSession(s);
        }
    }
</script>

<div class="pb-chat" on:keydown={onPanelKeydown}>
    <div class="pb-chat__bar">
        <span class="pb-chat__title">{i18n.aiDockTitle}</span>
        <span class="fn__flex-1"></span>
        <button
            class="b3-button b3-button--text pb-chat__icon"
            class:pb-chat__icon--on={showHistory}
            title={i18n.aiHistory}
            on:click={() => (showHistory = !showHistory)}
        >
            {i18n.aiHistory}
        </button>
        <button class="b3-button b3-button--text pb-chat__icon" title={i18n.aiNewChat} on:click={newChat}>
            {i18n.aiNewChat}
        </button>
        <button
            class="b3-button b3-button--text pb-chat__icon"
            class:pb-chat__icon--on={showConfig}
            title={i18n.aiSettings}
            on:click={() => (showConfig = !showConfig)}
        >
            {i18n.aiSettings}
        </button>
    </div>

    {#if showConfig}
        <div class="pb-chat__config">
            <label class="pb-chat__label" for="pb-ai-provider">{i18n.aiProvider}</label>
            <select
                id="pb-ai-provider"
                class="b3-select pb-chat__full"
                bind:value={config.provider}
                on:change={refreshModels}
            >
                {#each providers as p (p)}
                    <option value={p}>{p}</option>
                {/each}
            </select>

            <label class="pb-chat__label" for="pb-ai-model">{i18n.aiModel}</label>
            <select id="pb-ai-model" class="b3-select pb-chat__full" bind:value={config.model}>
                {#each models as m (m.id)}
                    <option value={m.id}>{m.name}</option>
                {/each}
            </select>

            <label class="pb-chat__label" for="pb-ai-key">{i18n.aiApiKey}</label>
            <input
                id="pb-ai-key"
                class="b3-text-field pb-chat__full"
                type="password"
                bind:value={config.apiKey}
                placeholder={i18n.aiApiKeyPlaceholder}
            />

            <label class="pb-chat__label" for="pb-ai-base">{i18n.aiBaseUrl}</label>
            <input
                id="pb-ai-base"
                class="b3-text-field pb-chat__full"
                bind:value={config.baseUrl}
                placeholder={i18n.aiBaseUrlPlaceholder}
            />

            <label class="pb-chat__label" for="pb-ai-sys">{i18n.aiSystemPrompt}</label>
            <textarea
                id="pb-ai-sys"
                class="b3-text-field pb-chat__full pb-chat__sys"
                rows="4"
                bind:value={config.systemPrompt}
                placeholder={i18n.aiSystemPromptPlaceholder}
            ></textarea>

            <button class="b3-button pb-chat__full" on:click={saveConfig}>{i18n.aiSaveConfig}</button>
            <p class="pb-chat__hint">{i18n.aiKeyHint}</p>
        </div>
    {:else if showHistory}
        <div class="pb-history">
            {#if sessions.length === 0}
                <div class="pb-chat__empty">{i18n.aiNoHistory}</div>
            {/if}
            {#each sessions as s (s.id)}
                <div
                    class="pb-history__item"
                    class:pb-history__item--active={s.id === currentSessionId}
                    role="button"
                    tabindex="0"
                    on:click={() => switchSession(s)}
                    on:keydown={(e) => onHistoryKey(e, s)}
                >
                    <span class="pb-history__title">{s.title}</span>
                    <button
                        class="pb-history__del"
                        title={i18n.aiDeleteTitle}
                        on:click={(e) => deleteSession(s, e)}
                    >
                        ✕
                    </button>
                </div>
            {/each}
        </div>
    {:else}
        <div class="pb-chat__list" bind:this={listEl}>
            {#if entries.length === 0 && !running}
                <div class="pb-chat__empty">{i18n.aiEmptyHint}</div>
            {/if}
            {#each entries as entry, i (i)}
                {#if entry.kind === "user"}
                    <div class="pb-msg pb-msg--user"><div class="pb-msg__body">{entry.text}</div></div>
                {:else if entry.kind === "assistant"}
                    <div class="pb-msg pb-msg--assistant">
                        {#if entry.text}<div class="pb-msg__body">{entry.text}</div>{/if}
                        {#each entry.tools as t, ti (ti)}
                            <details class="pb-tool">
                                <summary class="pb-tool__name">🔧 {t.name}</summary>
                                {#if t.args}<pre class="pb-tool__body">{t.args}</pre>{/if}
                            </details>
                        {/each}
                    </div>
                {:else}
                    <details class="pb-tool" class:pb-tool--error={entry.isError}>
                        <summary class="pb-tool__name">✓ {entry.name}</summary>
                        {#if entry.text}<pre class="pb-tool__body">{entry.text}</pre>{/if}
                    </details>
                {/if}
            {/each}

            {#if pendingConfirm}
                <div class="pb-confirm">
                    <div class="pb-confirm__title">{i18n.aiConfirmWrite}</div>
                    <div class="pb-confirm__summary">{pendingConfirm.summary}</div>
                    {#if pendingConfirm.diff.length > 0}
                        <div class="pb-diff">
                            {#each pendingConfirm.diff as line, di (di)}
                                <div class="pb-diff__line pb-diff__line--{line.type}">{line.text || " "}</div>
                            {/each}
                        </div>
                    {/if}
                    <div class="pb-confirm__actions">
                        <button class="b3-button b3-button--text" on:click={() => approve(false)}>{i18n.aiReject}</button>
                        <button class="b3-button b3-button--text" on:click={approveAll}>{i18n.aiApproveAll}</button>
                        <button class="b3-button" on:click={() => approve(true)}>{i18n.aiApprove}</button>
                    </div>
                </div>
            {:else if activeTool}
                <div class="pb-tool pb-tool--active">
                    <div class="pb-tool__name">⚙ {activeTool.name}</div>
                    {#if activeTool.args}<pre class="pb-tool__body">{activeTool.args}</pre>{/if}
                </div>
            {:else if running}
                <div class="pb-msg pb-msg--assistant">
                    <div class="pb-loading" aria-label={i18n.aiBusyPlaceholder}>
                        <span></span><span></span><span></span>
                    </div>
                </div>
            {/if}
        </div>

        <div class="pb-chat__input">
            {#if queue.length > 0}
                <div class="pb-queue">
                    {#each queue as q (q.id)}
                        <div class="pb-queue__item">
                            <span class="pb-queue__text" title={q.text}>{q.text}</span>
                            <button class="pb-queue__btn" title={i18n.aiSendNow} on:click={() => sendNow(q)}>
                                ⏩
                            </button>
                            <button class="pb-queue__btn" title={i18n.aiRemove} on:click={() => removeQueued(q.id)}>
                                ✕
                            </button>
                        </div>
                    {/each}
                </div>
            {/if}
            <textarea
                class="b3-text-field pb-chat__textarea"
                rows="3"
                bind:value={input}
                on:keydown={onKeydown}
                placeholder={running ? i18n.aiQueuePlaceholder : i18n.aiInputPlaceholder}
            ></textarea>
            <div class="pb-chat__actions">
                <label class="pb-yolo" title={i18n.aiYoloHint}>
                    <input class="b3-switch" type="checkbox" bind:checked={yolo} />
                    {i18n.aiYolo}
                </label>
                <span class="fn__flex-1"></span>
                {#if running}
                    <button class="b3-button b3-button--cancel" on:click={stopAll}>{i18n.aiStop}</button>
                {/if}
                <button class="b3-button" on:click={send} disabled={!input.trim()}>
                    {running ? i18n.aiQueue : i18n.aiSend}
                </button>
            </div>
        </div>
    {/if}
</div>

<style lang="scss">
    .pb-chat {
        display: flex;
        flex-direction: column;
        height: 100%;
        box-sizing: border-box;
    }

    .pb-chat__bar {
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 6px 8px;
        border-bottom: 1px solid var(--b3-border-color);
    }

    .pb-chat__title {
        font-weight: 500;
    }

    .pb-chat__icon {
        font-size: 12px;

        &--on {
            color: var(--b3-theme-primary);
        }
    }

    .pb-chat__config {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 12px;
        overflow-y: auto;
    }

    .pb-chat__label {
        font-size: 12px;
        font-weight: 500;
        margin-top: 4px;
    }

    .pb-chat__full {
        width: 100%;
        box-sizing: border-box;
    }

    .pb-chat__sys {
        resize: vertical;
        font-family: var(--b3-font-family-code, monospace);
        font-size: 12px;
    }

    .pb-chat__hint {
        font-size: 11px;
        color: var(--b3-theme-on-surface-light);
        margin: 6px 0 0;
    }

    .pb-history {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .pb-history__item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        border-radius: var(--b3-border-radius);
        cursor: pointer;

        &:hover {
            background: var(--b3-list-hover);
        }

        &--active {
            background: var(--b3-theme-primary-lightest);
        }
    }

    .pb-history__title {
        flex: 1;
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .pb-history__del {
        border: none;
        background: transparent;
        color: var(--b3-theme-on-surface-light);
        cursor: pointer;
        padding: 2px 4px;
        border-radius: var(--b3-border-radius);

        &:hover {
            color: var(--b3-theme-error);
            background: var(--b3-theme-error-lighter);
        }
    }

    .pb-chat__list {
        flex: 1;
        overflow-y: auto;
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .pb-chat__empty {
        color: var(--b3-theme-on-surface-light);
        font-size: 13px;
        text-align: center;
        margin-top: 24px;
    }

    .pb-msg {
        font-size: 13px;
        line-height: 1.5;

        &__body {
            white-space: pre-wrap;
            word-break: break-word;
        }
    }

    .pb-msg--user {
        align-self: flex-end;
        max-width: 90%;

        .pb-msg__body {
            background: var(--b3-theme-primary-lightest);
            padding: 6px 10px;
            border-radius: var(--b3-border-radius);
        }
    }

    .pb-msg--assistant {
        align-self: flex-start;
        max-width: 100%;
    }

    .pb-tool {
        align-self: flex-start;
        max-width: 100%;
        width: 100%;
        border-left: 2px solid var(--b3-border-color);
        padding-left: 8px;
        box-sizing: border-box;

        &--error {
            border-left-color: var(--b3-theme-error);
        }

        &--active {
            border-left-color: var(--b3-theme-primary);
        }

        &__name {
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            color: var(--b3-theme-on-surface);
            list-style: revert;
        }

        &__body {
            margin: 4px 0 0;
            font-family: var(--b3-font-family-code, monospace);
            font-size: 11px;
            color: var(--b3-theme-on-surface-light);
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 160px;
            overflow: auto;
        }
    }

    .pb-tool--error .pb-tool__body {
        color: var(--b3-theme-error);
    }

    .pb-loading {
        display: inline-flex;
        gap: 4px;
        padding: 4px 0;

        span {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--b3-theme-on-surface-light);
            animation: pb-bounce 1.2s infinite ease-in-out both;
        }

        span:nth-child(1) {
            animation-delay: -0.24s;
        }

        span:nth-child(2) {
            animation-delay: -0.12s;
        }
    }

    @keyframes pb-bounce {
        0%,
        80%,
        100% {
            transform: scale(0.6);
            opacity: 0.4;
        }
        40% {
            transform: scale(1);
            opacity: 1;
        }
    }

    .pb-confirm {
        align-self: stretch;
        border: 1px solid var(--b3-theme-primary);
        border-radius: var(--b3-border-radius);
        padding: 8px 10px;
        background: var(--b3-theme-surface);
    }

    .pb-confirm__title {
        font-weight: 500;
        font-size: 13px;
    }

    .pb-confirm__summary {
        font-size: 12px;
        color: var(--b3-theme-on-surface-light);
        margin-top: 2px;
        word-break: break-all;
    }

    .pb-confirm__actions {
        display: flex;
        justify-content: flex-end;
        gap: 4px;
        margin-top: 8px;
    }

    .pb-diff {
        font-family: var(--b3-font-family-code, monospace);
        font-size: 11px;
        max-height: 200px;
        overflow: auto;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        margin: 6px 0;
    }

    .pb-diff__line {
        white-space: pre-wrap;
        word-break: break-word;
        padding: 0 6px;

        &--add {
            background: rgba(46, 160, 67, 0.15);
        }

        &--del {
            background: rgba(248, 81, 73, 0.15);
        }

        &--same {
            color: var(--b3-theme-on-surface-light);
        }
    }

    .pb-chat__input {
        border-top: 1px solid var(--b3-border-color);
        padding: 8px;
    }

    .pb-queue {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-bottom: 6px;
    }

    .pb-queue__item {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        background: var(--b3-theme-surface-lighter);
        border: 1px dashed var(--b3-border-color);
        border-radius: var(--b3-border-radius);
    }

    .pb-queue__text {
        flex: 1;
        font-size: 12px;
        color: var(--b3-theme-on-surface-light);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .pb-queue__btn {
        border: none;
        background: transparent;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: var(--b3-border-radius);
        font-size: 12px;

        &:hover {
            background: var(--b3-list-hover);
        }
    }

    .pb-chat__textarea {
        width: 100%;
        box-sizing: border-box;
        resize: none;
    }

    .pb-chat__actions {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 6px;
    }

    .pb-yolo {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        cursor: pointer;
        user-select: none;
    }
</style>
