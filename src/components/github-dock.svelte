<script lang="ts">
    import { onMount } from "svelte";
    import { showMessage, confirm } from "siyuan";
    import type PenBridgePlugin from "../index";
    import {
        loadGitHubConfig,
        saveGitHubConfig,
        activeRepo,
        isRepoValid,
        type GitHubConfig,
        type GitHubRepoConfig,
    } from "../github/config";
    import {
        GitHubClient,
        GitHubError,
        type GitHubIssue,
        type GitHubPull,
        type GitHubLabel,
        type GitHubComment,
        type GitHubUser,
    } from "../github/client";
    import { openInBrowser, copyToClipboard, relativeTime, labelTextColor } from "../github/util";

    export let plugin: PenBridgePlugin;
    const i18n: any = plugin.i18n;

    type Tab = "issues" | "pulls" | "labels";
    type View = "list" | "issue-detail" | "pull-detail" | "issue-create" | "config";

    let config: GitHubConfig = { repos: [], activeIndex: 0 };
    let client: GitHubClient | null = null;

    let tab: Tab = "issues";
    let view: View = "list";
    let loading = false;
    let busy = false; // 写操作进行中
    let errorMsg = "";

    // 列表数据
    let issues: GitHubIssue[] = [];
    let pulls: GitHubPull[] = [];
    let labels: GitHubLabel[] = [];
    let issueState: "open" | "closed" | "all" = "open";
    let pullState: "open" | "closed" | "all" = "open";

    /** 仓库所有 label（多选用），切换仓库时刷新 */
    let repoLabels: GitHubLabel[] = [];

    // ---- Issue 筛选 ----
    let showFilters = false;
    let filterLabels: string[] = []; // 选中的 label 名
    let filterAssignee = ""; // "" = 全部，"none" = 未指派，或用户名
    let filterSort: "updated" | "created" | "comments" = "updated";
    let filterDir: "desc" | "asc" = "desc";
    let searchKeyword = "";
    /** 仓库可指派成员，用于 assignee 下拉 */
    let repoAssignees: GitHubUser[] = [];

    $: activeFilterCount =
        filterLabels.length +
        (filterAssignee ? 1 : 0) +
        (searchKeyword.trim() ? 1 : 0) +
        (filterSort !== "updated" || filterDir !== "desc" ? 1 : 0);

    // 详情数据
    let currentIssue: GitHubIssue | null = null;
    let currentPull: GitHubPull | null = null;
    let currentComments: GitHubComment[] = [];
    let currentDiff = "";
    let newComment = "";

    // 创建 issue 表单
    let formTitle = "";
    let formBody = "";
    let formLabelNames: string[] = [];

    // 仓库配置编辑
    let editRepos: GitHubRepoConfig[] = [];
    let verifyingIndex = -1;
    let showTokenIndex = -1;

    onMount(async () => {
        config = await loadGitHubConfig(plugin);
        rebuildClient();
        if (client) {
            void loadRepoLabels();
            void refresh();
        } else {
            openConfig();
        }
    });

    function rebuildClient() {
        const repo = activeRepo(config);
        client = isRepoValid(repo) ? new GitHubClient(repo) : null;
    }

    function reportError(e: unknown) {
        errorMsg = e instanceof GitHubError ? `${e.status}: ${e.message}` : String(e);
    }

    /** 预拉仓库 label 与可指派成员，用于筛选；静默失败。 */
    async function loadRepoLabels() {
        if (!client) return;
        try {
            repoLabels = await client.listLabels();
        } catch {
            repoLabels = [];
        }
        try {
            repoAssignees = await client.listAssignees();
        } catch {
            repoAssignees = [];
        }
    }

    async function refresh() {
        if (!client) return;
        loading = true;
        errorMsg = "";
        try {
            if (tab === "issues") {
                const labelsParam = filterLabels.join(",") || undefined;
                if (searchKeyword.trim()) {
                    // 有关键词 → 走 Search API
                    issues = await client.searchIssues({
                        keyword: searchKeyword,
                        state: issueState,
                        labels: labelsParam,
                        assignee: filterAssignee || undefined,
                    });
                } else {
                    const all = await client.listIssues({
                        state: issueState,
                        labels: labelsParam,
                        assignee: filterAssignee || undefined,
                        sort: filterSort,
                        direction: filterDir,
                    });
                    issues = all.filter((it) => !it.pull_request);
                }
            } else if (tab === "pulls") {
                pulls = await client.listPulls({ state: pullState });
            } else {
                labels = await client.listLabels();
                repoLabels = labels;
            }
        } catch (e) {
            reportError(e);
        } finally {
            loading = false;
        }
    }

    function toggleFilterLabel(name: string) {
        filterLabels = filterLabels.includes(name)
            ? filterLabels.filter((n) => n !== name)
            : [...filterLabels, name];
        void refresh();
    }

    function applyFilters() {
        void refresh();
    }

    function resetFilters() {
        filterLabels = [];
        filterAssignee = "";
        filterSort = "updated";
        filterDir = "desc";
        searchKeyword = "";
        void refresh();
    }

    function onSearchKey(e: KeyboardEvent) {
        if (e.key === "Enter") {
            e.preventDefault();
            void refresh();
        }
    }

    function switchTab(t: Tab) {
        tab = t;
        view = "list";
        void refresh();
    }

    function onRepoChange(idx: number) {
        config = { ...config, activeIndex: idx };
        void saveGitHubConfig(plugin, config);
        rebuildClient();
        view = "list";
        void loadRepoLabels();
        void refresh();
    }

    // ---------- Issue 详情 ----------
    async function openIssue(num: number) {
        if (!client) return;
        loading = true;
        errorMsg = "";
        try {
            currentIssue = await client.getIssue(num);
            currentPull = null;
            currentComments = await client.listComments(num);
            newComment = "";
            view = "issue-detail";
        } catch (e) {
            reportError(e);
        } finally {
            loading = false;
        }
    }

    async function submitComment() {
        const target = currentIssue ?? currentPull;
        if (!client || !target || !newComment.trim()) return;
        busy = true;
        try {
            const c = await client.addComment(target.number, newComment.trim());
            currentComments = [...currentComments, c];
            newComment = "";
            showMessage(i18n.ghCommentAdded);
        } catch (e) {
            reportError(e);
        } finally {
            busy = false;
        }
    }

    async function toggleIssueState() {
        if (!client || !currentIssue) return;
        const next = currentIssue.state === "open" ? "closed" : "open";
        busy = true;
        try {
            currentIssue = await client.updateIssue(currentIssue.number, { state: next });
            showMessage(next === "closed" ? i18n.ghIssueClosed : i18n.ghIssueReopened);
        } catch (e) {
            reportError(e);
        } finally {
            busy = false;
        }
    }

    /** 详情页直接增删 label。 */
    async function toggleIssueLabel(name: string) {
        if (!client || !currentIssue) return;
        const has = currentIssue.labels.some((l) => l.name === name);
        const next = has
            ? currentIssue.labels.filter((l) => l.name !== name).map((l) => l.name)
            : [...currentIssue.labels.map((l) => l.name), name];
        busy = true;
        try {
            currentIssue = await client.updateIssue(currentIssue.number, { labels: next });
        } catch (e) {
            reportError(e);
        } finally {
            busy = false;
        }
    }

    // ---------- Issue 创建 ----------
    function startCreate() {
        formTitle = "";
        formBody = "";
        formLabelNames = [];
        view = "issue-create";
    }

    function toggleFormLabel(name: string) {
        formLabelNames = formLabelNames.includes(name)
            ? formLabelNames.filter((n) => n !== name)
            : [...formLabelNames, name];
    }

    async function submitCreate() {
        if (!client || !formTitle.trim()) {
            showMessage(i18n.ghTitleRequired, 3000, "error");
            return;
        }
        busy = true;
        try {
            await client.createIssue({
                title: formTitle.trim(),
                body: formBody.trim() || undefined,
                labels: formLabelNames.length ? formLabelNames : undefined,
            });
            showMessage(i18n.ghIssueCreated);
            view = "list";
            await refresh();
        } catch (e) {
            reportError(e);
        } finally {
            busy = false;
        }
    }

    // ---------- PR 详情 ----------
    async function openPull(num: number) {
        if (!client) return;
        loading = true;
        errorMsg = "";
        try {
            currentPull = await client.getPull(num);
            currentIssue = null;
            currentComments = await client.listComments(num);
            currentDiff = await client.getPullDiff(num);
            newComment = "";
            view = "pull-detail";
        } catch (e) {
            reportError(e);
        } finally {
            loading = false;
        }
    }

    // ---------- Labels 管理 ----------
    let labelFormName = "";
    let labelFormColor = "ededed";
    let labelFormDesc = "";
    let showLabelForm = false;

    function startAddLabel() {
        labelFormName = "";
        labelFormColor = "ededed";
        labelFormDesc = "";
        showLabelForm = true;
    }

    async function submitLabel() {
        if (!client || !labelFormName.trim()) {
            showMessage(i18n.ghLabelName, 3000, "error");
            return;
        }
        busy = true;
        try {
            await client.createLabel({
                name: labelFormName.trim(),
                color: labelFormColor.replace(/^#/, "") || "ededed",
                description: labelFormDesc.trim() || undefined,
            });
            showLabelForm = false;
            await refresh();
        } catch (e) {
            reportError(e);
        } finally {
            busy = false;
        }
    }

    function removeLabel(name: string) {
        confirm(i18n.ghDeleteLabel, name, async () => {
            if (!client) return;
            busy = true;
            try {
                await client.deleteLabel(name);
                await refresh();
            } catch (e) {
                reportError(e);
            } finally {
                busy = false;
            }
        });
    }

    /** 复制当前详情（issue/PR）的 GitHub 链接到剪贴板。 */
    async function copyLink(url: string) {
        const ok = await copyToClipboard(url);
        showMessage(ok ? i18n.ghLinkCopied : i18n.ghLinkCopyFailed, 3000, ok ? "info" : "error");
    }

    // ---------- 导出到思源 ----------
    async function exportIssueToSiYuan() {
        const it = currentIssue;
        if (!it) return;
        try {
            const notebooks = await lsNotebooks();
            const nb = notebooks?.notebooks?.[0];
            if (!nb) {
                showMessage(i18n.ghNoNotebook, 3000, "error");
                return;
            }
            const md = [
                `# ${it.title}`,
                "",
                `> #${it.number} · ${it.state} · @${it.user?.login ?? "?"} · ${it.html_url}`,
                "",
                it.body ?? "",
                "",
                ...currentComments.flatMap((c) => [
                    `---`,
                    `**@${c.user?.login ?? "?"}** (${c.created_at}):`,
                    "",
                    c.body,
                    "",
                ]),
            ].join("\n");
            const repo = activeRepo(config);
            const path = `/GitHub/${repo?.name ?? "repo"}/#${it.number} ${it.title}`;
            await createDocWithMd(nb.id, path, md);
            showMessage(i18n.ghExported);
        } catch (e) {
            reportError(e);
        }
    }

    // ---------- 仓库配置 ----------
    function openConfig() {
        editRepos = config.repos.map((r) => ({ ...r }));
        if (editRepos.length === 0) editRepos = [blankRepo()];
        showTokenIndex = -1;
        view = "config";
    }

    function blankRepo(): GitHubRepoConfig {
        return { name: "", owner: "", repo: "", token: "" };
    }

    function addRepoRow() {
        editRepos = [...editRepos, blankRepo()];
    }

    function removeRepoRow(idx: number) {
        editRepos = editRepos.filter((_, i) => i !== idx);
        if (editRepos.length === 0) editRepos = [blankRepo()];
    }

    async function verifyRepo(idx: number) {
        const r = editRepos[idx];
        if (!isRepoValid(r)) {
            showMessage(i18n.ghRepoIncomplete, 3000, "error");
            return;
        }
        verifyingIndex = idx;
        try {
            const res = await new GitHubClient(r).verify();
            showMessage(
                res.ok ? i18n.ghVerifyOk : `${i18n.ghVerifyFail}: ${res.message}`,
                4000,
                res.ok ? "info" : "error",
            );
        } finally {
            verifyingIndex = -1;
        }
    }

    async function saveConfig() {
        const valid = editRepos.filter((r) => isRepoValid(r));
        if (valid.length === 0) {
            showMessage(i18n.ghRepoIncomplete, 3000, "error");
            return;
        }
        config = {
            repos: valid.map((r) => ({
                name: r.name.trim() || `${r.owner}/${r.repo}`,
                owner: r.owner.trim(),
                repo: r.repo.trim(),
                token: r.token.trim(),
            })),
            activeIndex: Math.min(config.activeIndex, valid.length - 1),
        };
        await saveGitHubConfig(plugin, config);
        rebuildClient();
        view = "list";
        showMessage(i18n.ghConfigSaved);
        void loadRepoLabels();
        await refresh();
    }

    function cancelConfig() {
        if (client) {
            view = "list";
        }
    }
</script>

<div class="pb-gh">
    <!-- 顶栏：仓库切换 + 操作 -->
    <header class="pb-gh__bar">
        {#if config.repos.length > 0}
            <select
                class="b3-select pb-gh__repo"
                value={config.activeIndex}
                on:change={(e) => onRepoChange(+e.currentTarget.value)}
            >
                {#each config.repos as r, i}
                    <option value={i}>{r.name}</option>
                {/each}
            </select>
        {:else}
            <span class="pb-gh__empty-repo">{i18n.ghNoRepo}</span>
        {/if}
        <span class="fn__flex-1"></span>
        {#if view !== "config"}
            <button class="pb-gh__icon-btn" title={i18n.ghRefresh} on:click={refresh} aria-label={i18n.ghRefresh}>
                <svg viewBox="0 0 16 16" width="15" height="15"><path fill="currentColor" d="M8 3a5 5 0 1 0 4.546 2.914l1.09-.502A6.2 6.2 0 1 1 8 1.8V0l3 2.4L8 4.8V3z"/></svg>
            </button>
        {/if}
        <button class="pb-gh__icon-btn" title={i18n.ghManageRepos} on:click={openConfig} aria-label={i18n.ghManageRepos}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M8 0a8.2 8.2 0 0 0-.701.031C6.444.095 5.95.645 5.928 1.16l-.046 1.063a.121.121 0 0 1-.082.103 5 5 0 0 0-.488.203.12.12 0 0 1-.13-.018l-.815-.685c-.394-.332-1.07-.348-1.488.029a8 8 0 0 0-.99.99c-.378.418-.362 1.094-.03 1.488l.685.815a.12.12 0 0 1 .018.13 5 5 0 0 0-.203.488.12.12 0 0 1-.103.082l-1.063.046C.645 5.95.095 6.444.031 7.3a8.2 8.2 0 0 0 0 1.4c.064.856.614 1.35 1.129 1.372l1.063.046c.045.002.082.036.103.082.06.166.127.329.203.488a.12.12 0 0 1-.018.13l-.685.815c-.332.394-.348 1.07.029 1.488.305.34.635.67.975.975.418.377 1.094.36 1.488.029l.815-.685a.12.12 0 0 1 .13-.018c.16.076.322.143.488.203.046.02.08.058.082.103l.046 1.063c.022.515.516 1.065 1.372 1.129a8.2 8.2 0 0 0 1.4 0c.856-.064 1.35-.614 1.372-1.129l.046-1.063a.12.12 0 0 1 .082-.103 5 5 0 0 0 .488-.203.12.12 0 0 1 .13.018l.815.685c.394.332 1.07.348 1.488-.029.34-.305.67-.635.975-.975.377-.418.36-1.094.029-1.488l-.685-.815a.12.12 0 0 1-.018-.13 5 5 0 0 0 .203-.488.12.12 0 0 1 .103-.082l1.063-.046c.515-.022 1.065-.516 1.129-1.372a8.2 8.2 0 0 0 0-1.4c-.064-.856-.614-1.35-1.129-1.372l-1.063-.046a.12.12 0 0 1-.103-.082 5 5 0 0 0-.203-.488.12.12 0 0 1 .018-.13l.685-.815c.332-.394.348-1.07-.029-1.488a8 8 0 0 0-.975-.975c-.418-.377-1.094-.36-1.488-.029l-.815.685a.12.12 0 0 1-.13.018 5 5 0 0 0-.488-.203.12.12 0 0 1-.082-.103l-.046-1.063C9.65.645 9.156.095 8.3.031 8.133.01 7.967 0 8 0Zm0 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z"/></svg>
        </button>
    </header>

    {#if view === "config"}
        <!-- 仓库配置 -->
        <div class="pb-gh__scroll pb-gh__config">
            {#each editRepos as r, i}
                <div class="pb-gh__repo-card">
                    <div class="pb-gh__field">
                        <label class="pb-gh__field-label">{i18n.ghRepoNamePh}</label>
                        <input class="b3-text-field" bind:value={r.name} placeholder="zpass" />
                    </div>
                    <div class="pb-gh__field">
                        <label class="pb-gh__field-label">owner / repo</label>
                        <div class="pb-gh__row">
                            <input class="b3-text-field" placeholder="owner" bind:value={r.owner} />
                            <span class="pb-gh__slash">/</span>
                            <input class="b3-text-field" placeholder="repo" bind:value={r.repo} />
                        </div>
                    </div>
                    <div class="pb-gh__field">
                        <label class="pb-gh__field-label">Token</label>
                        <div class="pb-gh__row">
                            {#if showTokenIndex === i}
                                <input
                                    class="b3-text-field pb-gh__grow"
                                    type="text"
                                    placeholder={i18n.ghTokenPh}
                                    bind:value={r.token}
                                />
                            {:else}
                                <input
                                    class="b3-text-field pb-gh__grow"
                                    type="password"
                                    placeholder={i18n.ghTokenPh}
                                    bind:value={r.token}
                                />
                            {/if}
                            <button
                                class="pb-gh__icon-btn"
                                title={showTokenIndex === i ? i18n.ghHide : i18n.ghShow}
                                on:click={() => (showTokenIndex = showTokenIndex === i ? -1 : i)}
                            >{showTokenIndex === i ? "🙈" : "👁"}</button>
                        </div>
                    </div>
                    <div class="pb-gh__row pb-gh__row--end">
                        <button class="b3-button b3-button--outline" on:click={() => verifyRepo(i)} disabled={verifyingIndex === i}>
                            {verifyingIndex === i ? i18n.ghVerifying : i18n.ghVerify}
                        </button>
                        <button class="b3-button b3-button--cancel" on:click={() => removeRepoRow(i)}>{i18n.ghRemove}</button>
                    </div>
                </div>
            {/each}
            <button class="b3-button b3-button--outline pb-gh__full" on:click={addRepoRow}>+ {i18n.ghAddRepo}</button>
            <div class="pb-gh__row pb-gh__row--end">
                {#if client}
                    <button class="b3-button b3-button--cancel" on:click={cancelConfig}>{i18n.cancel}</button>
                {/if}
                <button class="b3-button b3-button--primary" on:click={saveConfig}>{i18n.ghSaveConfig}</button>
            </div>
            <p class="pb-gh__hint">{i18n.ghTokenHint}</p>
        </div>
    {:else}
        <!-- 标签栏 -->
        <nav class="pb-gh__tabs">
            <button class="pb-gh__tab" class:pb-gh__tab--active={tab === "issues"} on:click={() => switchTab("issues")}>Issues</button>
            <button class="pb-gh__tab" class:pb-gh__tab--active={tab === "pulls"} on:click={() => switchTab("pulls")}>PRs</button>
            <button class="pb-gh__tab" class:pb-gh__tab--active={tab === "labels"} on:click={() => switchTab("labels")}>Labels</button>
        </nav>

        {#if errorMsg}
            <div class="pb-gh__error">⚠ {errorMsg}</div>
        {/if}

        {#if !client}
            <div class="pb-gh__placeholder">{i18n.ghConfigFirst}</div>
        {:else if loading}
            <div class="pb-gh__placeholder pb-gh__placeholder--spin">{i18n.ghLoading}</div>
        {:else if view === "list" && tab === "issues"}
            <div class="pb-gh__toolbar">
                <select class="b3-select pb-gh__state" bind:value={issueState} on:change={refresh}>
                    <option value="open">{i18n.ghStateOpen}</option>
                    <option value="closed">{i18n.ghStateClosed}</option>
                    <option value="all">{i18n.ghStateAll}</option>
                </select>
                <button
                    class="b3-button b3-button--outline pb-gh__filter-btn"
                    class:pb-gh__filter-btn--active={activeFilterCount > 0 || showFilters}
                    on:click={() => (showFilters = !showFilters)}
                    title={i18n.ghFilter}
                >
                    ⚲ {i18n.ghFilter}{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
                </button>
                <span class="fn__flex-1"></span>
                <button class="b3-button b3-button--outline" on:click={startCreate}>+ {i18n.ghNewIssue}</button>
            </div>
            {#if showFilters}
                <div class="pb-gh__filters">
                    <input
                        class="b3-text-field pb-gh__full"
                        placeholder={i18n.ghSearchPh}
                        bind:value={searchKeyword}
                        on:keydown={onSearchKey}
                    />
                    <div class="pb-gh__filter-row">
                        <select class="b3-select pb-gh__grow" bind:value={filterAssignee} on:change={applyFilters}>
                            <option value="">{i18n.ghAnyAssignee}</option>
                            <option value="none">{i18n.ghNoAssignee}</option>
                            {#each repoAssignees as u}
                                <option value={u.login}>@{u.login}</option>
                            {/each}
                        </select>
                    </div>
                    <div class="pb-gh__filter-row">
                        <select class="b3-select pb-gh__grow" bind:value={filterSort} on:change={applyFilters}>
                            <option value="updated">{i18n.ghSortUpdated}</option>
                            <option value="created">{i18n.ghSortCreated}</option>
                            <option value="comments">{i18n.ghSortComments}</option>
                        </select>
                        <select class="b3-select" bind:value={filterDir} on:change={applyFilters}>
                            <option value="desc">{i18n.ghDirDesc}</option>
                            <option value="asc">{i18n.ghDirAsc}</option>
                        </select>
                    </div>
                    {#if repoLabels.length}
                        <div class="pb-gh__filter-labels">
                            {#each repoLabels as l}
                                {@const on = filterLabels.includes(l.name)}
                                <button
                                    class="pb-gh__chip pb-gh__chip--toggle"
                                    class:pb-gh__chip--off={!on}
                                    style="background:#{l.color};color:{labelTextColor(l.color)}"
                                    on:click={() => toggleFilterLabel(l.name)}
                                    title={l.description ?? ""}
                                >{on ? "✓ " : ""}{l.name}</button>
                            {/each}
                        </div>
                    {/if}
                    <div class="pb-gh__filter-row pb-gh__filter-row--end">
                        {#if activeFilterCount > 0}
                            <button class="b3-button b3-button--cancel" on:click={resetFilters}>{i18n.ghResetFilter}</button>
                        {/if}
                        <button class="b3-button b3-button--outline" on:click={applyFilters}>{i18n.ghApplyFilter}</button>
                    </div>
                </div>
            {/if}
            <div class="pb-gh__scroll">
                {#each issues as it}
                    <button class="pb-gh__item" on:click={() => openIssue(it.number)}>
                        <span class="pb-gh__dot" class:pb-gh__dot--closed={it.state === "closed"}></span>
                        <div class="pb-gh__item-main">
                            <div class="pb-gh__item-title">{it.title}</div>
                            <div class="pb-gh__item-sub">
                                <span>#{it.number}</span>
                                <span>{relativeTime(it.updated_at)}</span>
                                {#if it.comments > 0}<span>💬 {it.comments}</span>{/if}
                            </div>
                            {#if it.labels.length}
                                <div class="pb-gh__chips">
                                    {#each it.labels as l}
                                        <span class="pb-gh__chip" style="background:#{l.color};color:{labelTextColor(l.color)}">{l.name}</span>
                                    {/each}
                                </div>
                            {/if}
                        </div>
                    </button>
                {:else}
                    <div class="pb-gh__placeholder">{i18n.ghNoIssues}</div>
                {/each}
            </div>
        {:else if view === "list" && tab === "pulls"}
            <div class="pb-gh__toolbar">
                <select class="b3-select pb-gh__state" bind:value={pullState} on:change={refresh}>
                    <option value="open">{i18n.ghStateOpen}</option>
                    <option value="closed">{i18n.ghStateClosed}</option>
                    <option value="all">{i18n.ghStateAll}</option>
                </select>
            </div>
            <div class="pb-gh__scroll">
                {#each pulls as p}
                    <button class="pb-gh__item" on:click={() => openPull(p.number)}>
                        <span class="pb-gh__dot" class:pb-gh__dot--closed={p.state === "closed" && !p.merged_at} class:pb-gh__dot--merged={!!p.merged_at}></span>
                        <div class="pb-gh__item-main">
                            <div class="pb-gh__item-title">{p.title}</div>
                            <div class="pb-gh__item-sub">
                                <span>#{p.number}</span>
                                <span>{relativeTime(p.updated_at)}</span>
                                {#if p.draft}<span class="pb-gh__badge">draft</span>{/if}
                                {#if p.merged_at}<span class="pb-gh__badge pb-gh__badge--merged">merged</span>{/if}
                            </div>
                        </div>
                    </button>
                {:else}
                    <div class="pb-gh__placeholder">{i18n.ghNoPulls}</div>
                {/each}
            </div>
        {:else if view === "list" && tab === "labels"}
            <div class="pb-gh__toolbar">
                <span class="fn__flex-1"></span>
                <button class="b3-button b3-button--outline" on:click={startAddLabel}>+ {i18n.ghNewLabel}</button>
            </div>
            {#if showLabelForm}
                <div class="pb-gh__label-form">
                    <input class="b3-text-field" placeholder={i18n.ghLabelName} bind:value={labelFormName} />
                    <div class="pb-gh__row">
                        <input class="pb-gh__color" type="color" value="#{labelFormColor}" on:input={(e) => (labelFormColor = e.currentTarget.value.replace('#', ''))} />
                        <input class="b3-text-field pb-gh__grow" placeholder={i18n.ghLabelColor} bind:value={labelFormColor} />
                    </div>
                    <input class="b3-text-field" placeholder={i18n.ghLabelDesc} bind:value={labelFormDesc} />
                    <div class="pb-gh__row pb-gh__row--end">
                        <button class="b3-button b3-button--cancel" on:click={() => (showLabelForm = false)}>{i18n.cancel}</button>
                        <button class="b3-button b3-button--primary" on:click={submitLabel} disabled={busy}>{i18n.ghCreate}</button>
                    </div>
                </div>
            {/if}
            <div class="pb-gh__scroll">
                {#each labels as l}
                    <div class="pb-gh__label-row">
                        <span class="pb-gh__chip" style="background:#{l.color};color:{labelTextColor(l.color)}">{l.name}</span>
                        <span class="pb-gh__label-desc">{l.description ?? ""}</span>
                        <span class="fn__flex-1"></span>
                        <button class="pb-gh__icon-btn" title={i18n.ghDeleteLabel} on:click={() => removeLabel(l.name)}>✕</button>
                    </div>
                {:else}
                    <div class="pb-gh__placeholder">{i18n.ghNoLabels}</div>
                {/each}
            </div>
        {:else if view === "issue-detail" && currentIssue}
            <div class="pb-gh__scroll pb-gh__detail">
                <div class="pb-gh__detail-head">
                    <button class="pb-gh__back" on:click={() => (view = "list")}>← {i18n.ghBack}</button>
                    <span class="fn__flex-1"></span>
                    <button class="pb-gh__icon-btn" title={i18n.ghCopyLink} on:click={() => copyLink(currentIssue.html_url)} aria-label={i18n.ghCopyLink}>
                        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M7.78 1.97a.75.75 0 0 1 0 1.06L6.06 4.75a2.25 2.25 0 0 0 3.18 3.18l1.72-1.72a.75.75 0 1 1 1.06 1.06l-1.72 1.72a3.75 3.75 0 0 1-5.3-5.3l1.72-1.72a.75.75 0 0 1 1.06 0Z"/><path d="M8.22 14.03a.75.75 0 0 1 0-1.06l1.72-1.72a2.25 2.25 0 0 0-3.18-3.18L5.04 9.79a.75.75 0 0 1-1.06-1.06l1.72-1.72a3.75 3.75 0 0 1 5.3 5.3l-1.72 1.72a.75.75 0 0 1-1.06 0Z"/></svg>
                    </button>
                    <button class="pb-gh__icon-btn" title={i18n.ghOpenBrowser} on:click={() => openInBrowser(currentIssue.html_url)}>🌐</button>
                </div>
                <span class="pb-gh__state-badge" class:pb-gh__state-badge--closed={currentIssue.state === "closed"}>
                    {currentIssue.state === "open" ? i18n.ghStateOpen : i18n.ghStateClosed}
                </span>
                <h3 class="pb-gh__detail-title">{currentIssue.title} <span class="pb-gh__num">#{currentIssue.number}</span></h3>
                <div class="pb-gh__meta">@{currentIssue.user?.login ?? "?"} · {relativeTime(currentIssue.created_at)}</div>

                <!-- 详情内多选 label -->
                <div class="pb-gh__label-picker">
                    {#each repoLabels as l}
                        {@const on = currentIssue.labels.some((x) => x.name === l.name)}
                        <button
                            class="pb-gh__chip pb-gh__chip--toggle"
                            class:pb-gh__chip--off={!on}
                            style="background:#{l.color};color:{labelTextColor(l.color)}"
                            on:click={() => toggleIssueLabel(l.name)}
                            disabled={busy}
                            title={l.description ?? ""}
                        >{on ? "✓ " : ""}{l.name}</button>
                    {/each}
                </div>

                <div class="pb-gh__actions">
                    <button class="b3-button b3-button--outline" on:click={toggleIssueState} disabled={busy}>
                        {currentIssue.state === "open" ? i18n.ghClose : i18n.ghReopen}
                    </button>
                    <button class="b3-button b3-button--outline" on:click={exportIssueToSiYuan}>{i18n.ghExport}</button>
                </div>

                {#if currentIssue.body}<div class="pb-gh__body">{currentIssue.body}</div>{/if}

                <div class="pb-gh__comments">
                    {#each currentComments as c}
                        <div class="pb-gh__comment">
                            <div class="pb-gh__comment-head">@{c.user?.login ?? "?"} · {relativeTime(c.created_at)}</div>
                            <div class="pb-gh__comment-body">{c.body}</div>
                        </div>
                    {/each}
                </div>

                <div class="pb-gh__comment-box">
                    <textarea class="b3-text-field" rows="3" placeholder={i18n.ghCommentPh} bind:value={newComment}></textarea>
                    <button class="b3-button b3-button--primary" on:click={submitComment} disabled={!newComment.trim() || busy}>{i18n.ghComment}</button>
                </div>
            </div>
        {:else if view === "pull-detail" && currentPull}
            <div class="pb-gh__scroll pb-gh__detail">
                <div class="pb-gh__detail-head">
                    <button class="pb-gh__back" on:click={() => (view = "list")}>← {i18n.ghBack}</button>
                    <span class="fn__flex-1"></span>
                    <button class="pb-gh__icon-btn" title={i18n.ghCopyLink} on:click={() => copyLink(currentPull.html_url)} aria-label={i18n.ghCopyLink}>
                        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M7.78 1.97a.75.75 0 0 1 0 1.06L6.06 4.75a2.25 2.25 0 0 0 3.18 3.18l1.72-1.72a.75.75 0 1 1 1.06 1.06l-1.72 1.72a3.75 3.75 0 0 1-5.3-5.3l1.72-1.72a.75.75 0 0 1 1.06 0Z"/><path d="M8.22 14.03a.75.75 0 0 1 0-1.06l1.72-1.72a2.25 2.25 0 0 0-3.18-3.18L5.04 9.79a.75.75 0 0 1-1.06-1.06l1.72-1.72a3.75 3.75 0 0 1 5.3 5.3l-1.72 1.72a.75.75 0 0 1-1.06 0Z"/></svg>
                    </button>
                    <button class="pb-gh__icon-btn" title={i18n.ghOpenBrowser} on:click={() => openInBrowser(currentPull.html_url)}>🌐</button>
                </div>
                <span class="pb-gh__state-badge" class:pb-gh__state-badge--merged={!!currentPull.merged_at} class:pb-gh__state-badge--closed={currentPull.state === "closed" && !currentPull.merged_at}>
                    {currentPull.merged_at ? "merged" : currentPull.state === "open" ? i18n.ghStateOpen : i18n.ghStateClosed}
                </span>
                <h3 class="pb-gh__detail-title">{currentPull.title} <span class="pb-gh__num">#{currentPull.number}</span></h3>
                <div class="pb-gh__meta">@{currentPull.user?.login ?? "?"} · {currentPull.base.ref} ← {currentPull.head.ref}</div>

                {#if currentPull.body}<div class="pb-gh__body">{currentPull.body}</div>{/if}

                <details class="pb-gh__diff-wrap">
                    <summary>{i18n.ghDiff}</summary>
                    <pre class="pb-gh__diff">{currentDiff}</pre>
                </details>

                <div class="pb-gh__comments">
                    {#each currentComments as c}
                        <div class="pb-gh__comment">
                            <div class="pb-gh__comment-head">@{c.user?.login ?? "?"} · {relativeTime(c.created_at)}</div>
                            <div class="pb-gh__comment-body">{c.body}</div>
                        </div>
                    {/each}
                </div>

                <div class="pb-gh__comment-box">
                    <textarea class="b3-text-field" rows="3" placeholder={i18n.ghCommentPh} bind:value={newComment}></textarea>
                    <button class="b3-button b3-button--primary" on:click={submitComment} disabled={!newComment.trim() || busy}>{i18n.ghComment}</button>
                </div>
            </div>
        {:else if view === "issue-create"}
            <div class="pb-gh__scroll pb-gh__detail pb-gh__create">
                <button class="pb-gh__back" on:click={() => (view = "list")}>← {i18n.ghBack}</button>
                <input class="b3-text-field pb-gh__full" placeholder={i18n.ghTitle} bind:value={formTitle} />
                <textarea class="b3-text-field pb-gh__full" rows="6" placeholder={i18n.ghBodyPh} bind:value={formBody}></textarea>
                <div class="pb-gh__field-label">{i18n.ghLabels}</div>
                <div class="pb-gh__label-picker">
                    {#each repoLabels as l}
                        {@const on = formLabelNames.includes(l.name)}
                        <button
                            class="pb-gh__chip pb-gh__chip--toggle"
                            class:pb-gh__chip--off={!on}
                            style="background:#{l.color};color:{labelTextColor(l.color)}"
                            on:click={() => toggleFormLabel(l.name)}
                            title={l.description ?? ""}
                        >{on ? "✓ " : ""}{l.name}</button>
                    {:else}
                        <span class="pb-gh__hint">{i18n.ghNoLabels}</span>
                    {/each}
                </div>
                <button class="b3-button b3-button--primary pb-gh__full" on:click={submitCreate} disabled={busy}>{i18n.ghCreate}</button>
            </div>
        {/if}
    {/if}
</div>

<style lang="scss">
    .pb-gh {
        display: flex;
        flex-direction: column;
        height: 100%;
        font-size: 13px;
        color: var(--b3-theme-on-background);

        &__bar {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 6px 8px;
            border-bottom: 1px solid var(--b3-border-color);
            flex-shrink: 0;
        }
        &__repo {
            max-width: 160px;
        }
        &__empty-repo {
            color: var(--b3-theme-on-surface-light);
        }
        &__icon-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 26px;
            height: 26px;
            padding: 0 5px;
            background: transparent;
            border: none;
            border-radius: 4px;
            color: var(--b3-theme-on-surface);
            cursor: pointer;
            font-size: 13px;
            &:hover {
                background: var(--b3-list-hover);
            }
        }

        &__tabs {
            display: flex;
            border-bottom: 1px solid var(--b3-border-color);
            flex-shrink: 0;
        }
        &__tab {
            flex: 1;
            padding: 9px 0;
            background: transparent;
            border: none;
            border-bottom: 2px solid transparent;
            color: var(--b3-theme-on-surface);
            cursor: pointer;
            font-weight: 500;
            &:hover {
                color: var(--b3-theme-on-background);
            }
            &--active {
                border-bottom-color: var(--b3-theme-primary);
                color: var(--b3-theme-primary);
            }
        }

        &__toolbar {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 6px;
            padding: 8px;
            flex-shrink: 0;
        }
        &__state {
            max-width: 96px;
        }
        &__filter-btn {
            white-space: nowrap;
            &--active {
                border-color: var(--b3-theme-primary);
                color: var(--b3-theme-primary);
            }
        }
        &__filters {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 0 8px 10px;
            border-bottom: 1px solid var(--b3-border-color);
            flex-shrink: 0;
        }
        &__filter-row {
            display: flex;
            gap: 6px;
            &--end {
                justify-content: flex-end;
            }
        }
        &__filter-labels {
            display: flex;
            flex-wrap: wrap;
            gap: 5px;
            max-height: 96px;
            overflow-y: auto;
        }

        &__scroll {
            flex: 1;
            overflow-y: auto;
            min-height: 0;
        }

        &__item {
            display: flex;
            gap: 8px;
            width: 100%;
            padding: 10px 8px;
            background: transparent;
            border: none;
            border-bottom: 1px solid var(--b3-border-color);
            text-align: left;
            cursor: pointer;
            &:hover {
                background: var(--b3-list-hover);
            }
        }
        &__dot {
            flex-shrink: 0;
            width: 8px;
            height: 8px;
            margin-top: 5px;
            border-radius: 50%;
            background: #1a7f37; // open 绿
            &--closed {
                background: #cf222e; // closed 红
            }
            &--merged {
                background: #8957e5; // merged 紫
            }
        }
        &__item-main {
            flex: 1;
            min-width: 0;
        }
        &__item-title {
            font-weight: 500;
            line-height: 1.4;
            word-break: break-word;
        }
        &__item-sub {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 3px;
            font-size: 12px;
            color: var(--b3-theme-on-surface-light);
        }
        &__chips {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            margin-top: 5px;
        }
        &__chip {
            display: inline-block;
            padding: 1px 8px;
            border-radius: 9px;
            font-size: 11px;
            line-height: 16px;
            white-space: nowrap;
            &--toggle {
                cursor: pointer;
                border: none;
                padding: 4px 10px;
                line-height: 18px;
                transition: opacity 0.15s, filter 0.15s;
            }
            &--off {
                opacity: 0.45;
                filter: grayscale(0.3);
            }
        }
        &__badge {
            padding: 0 6px;
            border-radius: 8px;
            font-size: 11px;
            background: var(--b3-theme-surface-light);
            color: var(--b3-theme-on-surface);
            &--merged {
                background: #8957e5;
                color: #fff;
            }
        }

        &__num {
            color: var(--b3-theme-on-surface-light);
            font-weight: 400;
            font-variant-numeric: tabular-nums;
        }

        &__placeholder {
            padding: 24px 16px;
            text-align: center;
            color: var(--b3-theme-on-surface-light);
        }
        &__error {
            margin: 8px;
            padding: 8px 10px;
            border-radius: 4px;
            color: #cf222e;
            background: rgba(207, 34, 46, 0.1);
            word-break: break-word;
        }

        // ---- 详情 ----
        &__detail {
            padding: 10px 12px;
        }
        &__create {
            display: flex;
            flex-direction: column;
            gap: 12px;
            .pb-gh__back {
                align-self: flex-start;
            }
            .pb-gh__field-label {
                margin-bottom: -6px; // 紧贴其下的标签选择器
            }
            .pb-gh__label-picker {
                margin: 0;
            }
        }
        &__detail-head {
            display: flex;
            align-items: center;
            margin-bottom: 6px;
        }
        &__back {
            background: transparent;
            border: none;
            color: var(--b3-theme-primary);
            cursor: pointer;
            padding: 2px 0;
            font-size: 13px;
        }
        &__state-badge {
            display: inline-block;
            padding: 2px 10px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 500;
            color: #fff;
            background: #1a7f37;
            &--closed {
                background: #cf222e;
            }
            &--merged {
                background: #8957e5;
            }
        }
        &__detail-title {
            margin: 8px 0 4px;
            font-size: 15px;
            line-height: 1.4;
            word-break: break-word;
        }
        &__meta {
            color: var(--b3-theme-on-surface-light);
            font-size: 12px;
            margin-bottom: 8px;
        }
        &__label-picker {
            display: flex;
            flex-wrap: wrap;
            gap: 5px;
            margin: 8px 0;
        }
        &__actions {
            display: flex;
            gap: 6px;
            margin: 8px 0;
        }
        &__body {
            white-space: pre-wrap;
            word-break: break-word;
            margin: 8px 0;
            padding: 10px;
            background: var(--b3-theme-surface-light);
            border-radius: 6px;
            line-height: 1.5;
        }

        &__comments {
            margin-top: 8px;
        }
        &__comment {
            margin: 8px 0;
            padding: 8px 10px;
            border: 1px solid var(--b3-border-color);
            border-radius: 6px;
        }
        &__comment-head {
            font-size: 12px;
            font-weight: 500;
            color: var(--b3-theme-on-surface-light);
            margin-bottom: 5px;
        }
        &__comment-body {
            white-space: pre-wrap;
            word-break: break-word;
            line-height: 1.5;
        }
        &__comment-box {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-top: 10px;
            textarea {
                width: 100%;
                resize: vertical;
            }
        }

        &__diff-wrap {
            margin: 8px 0;
            summary {
                cursor: pointer;
                padding: 6px 0;
                color: var(--b3-theme-primary);
                user-select: none;
            }
        }
        &__diff {
            white-space: pre;
            overflow-x: auto;
            font-family: var(--b3-font-family-code, monospace);
            font-size: 12px;
            line-height: 1.45;
            background: var(--b3-theme-surface-light);
            padding: 10px;
            border-radius: 6px;
            max-height: 360px;
        }

        // ---- labels 管理 ----
        &__label-form {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 8px 12px 12px;
            border-bottom: 1px solid var(--b3-border-color);
        }
        &__color {
            width: 36px;
            height: 30px;
            padding: 0;
            border: 1px solid var(--b3-border-color);
            border-radius: 4px;
            background: none;
            cursor: pointer;
        }
        &__label-row {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 9px 8px;
            border-bottom: 1px solid var(--b3-border-color);
        }
        &__label-desc {
            color: var(--b3-theme-on-surface-light);
            font-size: 12px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        // ---- 配置 ----
        &__config {
            padding: 10px 12px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        &__repo-card {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 10px;
            border: 1px solid var(--b3-border-color);
            border-radius: 6px;
            background: var(--b3-theme-surface-light);
        }
        &__field {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        &__field-label {
            font-size: 12px;
            color: var(--b3-theme-on-surface-light);
        }
        &__row {
            display: flex;
            align-items: center;
            gap: 6px;
            &--end {
                justify-content: flex-end;
            }
        }
        &__slash {
            color: var(--b3-theme-on-surface-light);
        }
        &__grow {
            flex: 1;
        }
        &__full {
            width: 100%;
        }
        &__hint {
            font-size: 12px;
            line-height: 1.5;
            color: var(--b3-theme-on-surface-light);
            margin: 4px 0 0;
        }
    }
</style>
