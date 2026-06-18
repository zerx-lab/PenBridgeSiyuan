/**
 * GitHub 多仓库配置：每个仓库一组 { 名字, owner, repo, token }。
 * token 明文存于思源插件 data 目录（与现有 tencent-config 一致）。
 */
import type { Plugin } from "siyuan";

export const GITHUB_CONFIG_KEY = "github-config";

export interface GitHubRepoConfig {
    /** 用户可见名字，用于 select 快速切换 */
    name: string;
    owner: string;
    repo: string;
    token: string;
}

export interface GitHubConfig {
    repos: GitHubRepoConfig[];
    /** 当前激活仓库在 repos 中的索引 */
    activeIndex: number;
}

const EMPTY: GitHubConfig = { repos: [], activeIndex: 0 };

/** 读取配置；缺失或损坏时返回空配置。 */
export async function loadGitHubConfig(plugin: Plugin): Promise<GitHubConfig> {
    const raw = (await plugin.loadData(GITHUB_CONFIG_KEY)) as Partial<GitHubConfig> | null;
    if (!raw || !Array.isArray(raw.repos)) return { ...EMPTY };
    const repos = raw.repos.filter(
        (r): r is GitHubRepoConfig =>
            !!r && typeof r.owner === "string" && typeof r.repo === "string",
    );
    let activeIndex = typeof raw.activeIndex === "number" ? raw.activeIndex : 0;
    if (activeIndex < 0 || activeIndex >= repos.length) activeIndex = 0;
    return { repos, activeIndex };
}

export async function saveGitHubConfig(plugin: Plugin, config: GitHubConfig): Promise<void> {
    await plugin.saveData(GITHUB_CONFIG_KEY, config);
}

/** 返回当前激活仓库；无配置时返回 null。 */
export function activeRepo(config: GitHubConfig): GitHubRepoConfig | null {
    return config.repos[config.activeIndex] ?? null;
}

/** 校验 owner/repo/token 非空。 */
export function isRepoValid(r: GitHubRepoConfig | null): r is GitHubRepoConfig {
    return !!r && !!r.owner.trim() && !!r.repo.trim() && !!r.token.trim();
}
