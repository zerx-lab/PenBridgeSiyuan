/**
 * GitHub REST 客户端：所有请求走思源 kernel 的 forwardProxy 以绕过浏览器 CORS。
 * 鉴权用 per-repo 的 Personal Access Token（Authorization: Bearer）。
 */
import { forwardProxy } from "../api";
import { logger } from "../logger";
import type { GitHubRepoConfig } from "./config";

const API_BASE = "https://api.github.com";

export interface GitHubLabel {
    id: number;
    name: string;
    color: string;
    description: string | null;
}

export interface GitHubUser {
    login: string;
    avatar_url: string;
}

export interface GitHubIssue {
    number: number;
    title: string;
    body: string | null;
    state: "open" | "closed";
    user: GitHubUser | null;
    labels: GitHubLabel[];
    assignees: GitHubUser[];
    comments: number;
    created_at: string;
    updated_at: string;
    html_url: string;
    /** GitHub 把 PR 也归到 issues 接口；此字段存在则为 PR */
    pull_request?: unknown;
}

export interface GitHubComment {
    id: number;
    body: string;
    user: GitHubUser | null;
    created_at: string;
    html_url: string;
}

export interface GitHubPull {
    number: number;
    title: string;
    body: string | null;
    state: "open" | "closed";
    user: GitHubUser | null;
    labels: GitHubLabel[];
    draft: boolean;
    merged_at: string | null;
    created_at: string;
    updated_at: string;
    html_url: string;
    head: { ref: string };
    base: { ref: string };
}

export class GitHubError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
        this.name = "GitHubError";
    }
}

export class GitHubClient {
    constructor(private repo: GitHubRepoConfig) {}

    private get prefix() {
        return `/repos/${this.repo.owner}/${this.repo.repo}`;
    }

    private headers(accept = "application/vnd.github+json"): Array<Record<string, string>> {
        return [
            { Authorization: `Bearer ${this.repo.token}` },
            { Accept: accept },
            { "X-GitHub-Api-Version": "2022-11-28" },
            { "User-Agent": "PenBridge-SiYuan" },
        ];
    }

    /**
     * 发起请求。GET/DELETE 无 body；POST/PATCH 用 JSON 字符串 payload。
     * 返回已解析的 JSON（diff 等纯文本场景用 requestRaw）。
     */
    private async requestRaw(
        path: string,
        method: string,
        body?: unknown,
        accept?: string,
    ): Promise<{ status: number; text: string }> {
        const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
        const hasBody = body !== undefined && body !== null;
        const res = await forwardProxy(
            url,
            method,
            hasBody ? JSON.stringify(body) : "",
            this.headers(accept),
            15000,
            hasBody ? "application/json" : "text/html",
        );
        return { status: res?.status ?? 0, text: res?.body ?? "" };
    }

    private async requestJson<T>(
        path: string,
        method = "GET",
        body?: unknown,
    ): Promise<T> {
        const { status, text } = await this.requestRaw(path, method, body);
        if (status < 200 || status >= 300) {
            let msg = `HTTP ${status}`;
            try {
                const parsed = JSON.parse(text);
                if (parsed?.message) msg = parsed.message;
            } catch {
                /* 非 JSON 错误体 */
            }
            logger.warn("GitHub API error", status, path);
            throw new GitHubError(status, msg);
        }
        if (!text) return undefined as unknown as T;
        return JSON.parse(text) as T;
    }

    /** 校验 token 与仓库可达性。 */
    async verify(): Promise<{ ok: boolean; message: string }> {
        try {
            await this.requestJson<unknown>(this.prefix);
            return { ok: true, message: "" };
        } catch (e) {
            const msg = e instanceof GitHubError ? `${e.status}: ${e.message}` : String(e);
            return { ok: false, message: msg };
        }
    }

    // ---------------- Issues ----------------

    /** 列出 issues（GitHub 会混入 PR，调用方需用 pull_request 字段过滤）。 */
    listIssues(opts: {
        state?: "open" | "closed" | "all";
        /** 逗号分隔的 label 名 */
        labels?: string;
        /** assignee 用户名，"*" = 任意已指派，"none" = 未指派 */
        assignee?: string;
        sort?: "created" | "updated" | "comments";
        direction?: "asc" | "desc";
        page?: number;
    } = {}): Promise<GitHubIssue[]> {
        const params = new URLSearchParams({
            state: opts.state ?? "open",
            per_page: "50",
            page: String(opts.page ?? 1),
            sort: opts.sort ?? "updated",
            direction: opts.direction ?? "desc",
        });
        if (opts.labels) params.set("labels", opts.labels);
        if (opts.assignee) params.set("assignee", opts.assignee);
        return this.requestJson<GitHubIssue[]>(`${this.prefix}/issues?${params}`);
    }

    /** 关键词搜索 issues（仅本仓库，自动排除 PR）。 */
    async searchIssues(opts: {
        keyword: string;
        state?: "open" | "closed" | "all";
        labels?: string;
        assignee?: string;
    }): Promise<GitHubIssue[]> {
        const q: string[] = [
            `repo:${this.repo.owner}/${this.repo.repo}`,
            "type:issue",
        ];
        if (opts.state && opts.state !== "all") q.push(`state:${opts.state}`);
        if (opts.labels) {
            for (const l of opts.labels.split(",").filter(Boolean)) {
                q.push(`label:"${l}"`);
            }
        }
        if (opts.assignee && opts.assignee !== "*" && opts.assignee !== "none") {
            q.push(`assignee:${opts.assignee}`);
        } else if (opts.assignee === "none") {
            q.push("no:assignee");
        }
        if (opts.keyword.trim()) q.push(opts.keyword.trim());
        const params = new URLSearchParams({
            q: q.join(" "),
            per_page: "50",
            sort: "updated",
            order: "desc",
        });
        const res = await this.requestJson<{ items: GitHubIssue[] }>(
            `https://api.github.com/search/issues?${params}`,
        );
        return res?.items ?? [];
    }

    /** 可指派给该仓库 issue 的协作者列表。 */
    listAssignees(): Promise<GitHubUser[]> {
        return this.requestJson<GitHubUser[]>(`${this.prefix}/assignees?per_page=100`);
    }

    getIssue(num: number): Promise<GitHubIssue> {
        return this.requestJson<GitHubIssue>(`${this.prefix}/issues/${num}`);
    }

    listComments(num: number): Promise<GitHubComment[]> {
        return this.requestJson<GitHubComment[]>(
            `${this.prefix}/issues/${num}/comments?per_page=100`,
        );
    }

    createIssue(data: {
        title: string;
        body?: string;
        labels?: string[];
    }): Promise<GitHubIssue> {
        return this.requestJson<GitHubIssue>(`${this.prefix}/issues`, "POST", data);
    }

    /** 改标题/正文/状态/标签。 */
    updateIssue(
        num: number,
        data: {
            title?: string;
            body?: string;
            state?: "open" | "closed";
            labels?: string[];
        },
    ): Promise<GitHubIssue> {
        return this.requestJson<GitHubIssue>(`${this.prefix}/issues/${num}`, "PATCH", data);
    }

    addComment(num: number, body: string): Promise<GitHubComment> {
        return this.requestJson<GitHubComment>(
            `${this.prefix}/issues/${num}/comments`,
            "POST",
            { body },
        );
    }

    // ---------------- Pull Requests ----------------

    listPulls(opts: { state?: "open" | "closed" | "all"; page?: number } = {}): Promise<
        GitHubPull[]
    > {
        const params = new URLSearchParams({
            state: opts.state ?? "open",
            per_page: "30",
            page: String(opts.page ?? 1),
            sort: "updated",
            direction: "desc",
        });
        return this.requestJson<GitHubPull[]>(`${this.prefix}/pulls?${params}`);
    }

    getPull(num: number): Promise<GitHubPull> {
        return this.requestJson<GitHubPull>(`${this.prefix}/pulls/${num}`);
    }

    /** 取 PR 的 unified diff 文本。 */
    async getPullDiff(num: number): Promise<string> {
        const { status, text } = await this.requestRaw(
            `${this.prefix}/pulls/${num}`,
            "GET",
            undefined,
            "application/vnd.github.diff",
        );
        if (status < 200 || status >= 300) {
            throw new GitHubError(status, `HTTP ${status}`);
        }
        return text;
    }

    // ---------------- Labels ----------------

    listLabels(): Promise<GitHubLabel[]> {
        return this.requestJson<GitHubLabel[]>(`${this.prefix}/labels?per_page=100`);
    }

    createLabel(data: {
        name: string;
        color: string;
        description?: string;
    }): Promise<GitHubLabel> {
        return this.requestJson<GitHubLabel>(`${this.prefix}/labels`, "POST", data);
    }

    updateLabel(
        name: string,
        data: { new_name?: string; color?: string; description?: string },
    ): Promise<GitHubLabel> {
        return this.requestJson<GitHubLabel>(
            `${this.prefix}/labels/${encodeURIComponent(name)}`,
            "PATCH",
            data,
        );
    }

    deleteLabel(name: string): Promise<void> {
        return this.requestJson<void>(
            `${this.prefix}/labels/${encodeURIComponent(name)}`,
            "DELETE",
        );
    }
}
