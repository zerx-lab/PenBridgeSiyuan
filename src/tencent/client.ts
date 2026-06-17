/**
 * 腾讯云开发者社区 API 客户端
 * 所有 HTTP 请求经思源内核转发代理（/api/network/forwardProxy）
 * 移植自 penBridge/packages/server/src/services/tencentApi.ts
 */
import { forwardProxy } from "../api";
import type { TagInfo, DraftResult, PublishResult, ImageUploadInfo, CosTmpSecret } from "./types";
import { buildSummary } from "./markdown";
import { logger } from "../logger";

const BASE_URL = "https://cloud.tencent.com/developer";
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface ArticlePayload {
    title: string;
    /** 已包裹 <!--markdown--> 注释的内容 */
    content: string;
    /** 纯文本 */
    plain: string;
    tagIds: number[];
    /** 0-未选择, 1-原创, 2-转载, 3-翻译 */
    sourceType: number;
}

export class TencentClient {
    private cookie: string;

    constructor(cookie: string) {
        this.cookie = this.sanitizeCookie(cookie);
    }

    /**
     * 解析 cookie 字符串为键值对，删除 skey 字段后重新拼接。
     */
    private sanitizeCookie(raw: string): string {
        return raw
            .split(";")
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
                const idx = part.indexOf("=");
                if (idx <= 0) return null;
                return [part.slice(0, idx).trim(), part.slice(idx + 1).trim()] as [string, string];
            })
            .filter((kv): kv is [string, string] => !!kv && kv[0] !== "skey" && !!kv[1])
            .map(([key, value]) => `${key}=${value}`)
            .join("; ");
    }

    private async request<T = any>(path: string, payload: Record<string, unknown>): Promise<T> {
        // 取接口最后一段作为简短标识，便于错误定位
        const method = path.split("/").filter(Boolean).pop() ?? path;

        const res = await forwardProxy(
            `${BASE_URL}${path}`,
            "POST",
            payload,
            [
                { "Cookie": this.cookie },
                { "Referer": "https://cloud.tencent.com/developer/article/write-new" },
                { "Origin": "https://cloud.tencent.com" },
                { "User-Agent": USER_AGENT },
                { "Content-Type": "application/json" },
            ],
            15000,
            "application/json"
        );

        if (!res) {
            logger.error(`${method}: forwardProxy returned no response`);
            throw new Error(`${method} failed: kernel proxy returned no response`);
        }

        let result: any;
        try {
            result = JSON.parse(res.body);
        } catch {
            logger.error(`${method}: JSON parse failed, HTTP ${res.status}`);
            throw new Error(`${method} failed: HTTP ${res.status} (invalid JSON)`);
        }

        // 移植 tencentApi.ts 的响应判断：HTTP 状态码或响应中的错误码
        const code = result?.code ?? result?.errorCode;
        const msg = result?.msg || "unknown error";
        if (res.status < 200 || res.status >= 300 || (code && code !== 0)) {
            logger.error(`${method}: HTTP ${res.status}, code=${code ?? "–"}, msg=${msg}`);
            throw new Error(`${method} failed: [${code ?? res.status}] ${msg}`);
        }
        return result as T;
    }

    /** 验证登录状态：拉取草稿列表第 1 页 */
    async verifyAuth(): Promise<boolean> {
        await this.request("/api/article/getUserArticleDrafts", {
            page: 1,
            pageSize: 1,
            contentType: "markdown",
        });
        return true;
    }

    /** 搜索标签 */
    async searchTags(keyword: string): Promise<TagInfo[]> {
        const result = await this.request<any>("/api/tag/search", {
            keyword,
            limit: 20,
        });
        // 该接口直接返回数组；兼容 { data: [...] } / { list: [...] } 结构
        if (Array.isArray(result)) return result;
        if (Array.isArray(result?.data)) return result.data;
        if (Array.isArray(result?.list)) return result.list;
        return [];
    }

    /** 创建草稿 */
    async createDraft(params: ArticlePayload): Promise<DraftResult> {
        const result = await this.request<any>("/api/article/addArticleDraft", {
            articleId: 0,
            title: params.title,
            content: params.content,
            plain: params.plain,
            sourceType: params.sourceType,
            classifyIds: [],
            tagIds: params.tagIds,
            longtailTag: [],
            columnIds: [],
            openComment: 1,
            closeTextLink: 0,
            userSummary: "",
            pic: "",
            sourceDetail: {},
            zoneName: "",
            summary: "",
        });
        const draftId = result?.draftId ?? result?.data?.draftId;
        if (!draftId) {
            throw new Error("创建草稿失败：响应中没有 draftId");
        }
        return { draftId };
    }

    /** 更新草稿 */
    async updateDraft(params: ArticlePayload & { draftId: number; articleId?: number }): Promise<DraftResult> {
        await this.request("/api/article/editArticleDraft", {
            draftId: params.draftId,
            articleId: params.articleId || 0,
            title: params.title,
            content: params.content,
            plain: params.plain,
            sourceType: params.sourceType,
            classifyIds: [],
            tagIds: params.tagIds,
            longtailTag: [],
            columnIds: [],
            openComment: 1,
            closeTextLink: 0,
            userSummary: "",
            pic: "",
            sourceDetail: {},
            zoneName: "",
            summary: "",
        });
        return { draftId: params.draftId };
    }

    /** 发布文章 */
    async publishArticle(params: ArticlePayload & { draftId: number }): Promise<PublishResult> {
        const summary = buildSummary(params.plain);
        const result = await this.request<any>("/api/article/addArticle", {
            title: params.title,
            content: params.content,
            plain: params.plain,
            sourceType: params.sourceType,
            classifyIds: [],
            tagIds: params.tagIds,
            longtailTag: [],
            columnIds: [],
            banComment: 0,
            closeArticleTextLink: 0,
            userSummary: "",
            pic: "",
            zoneName: "",
            vlogIds: [],
            summary,
            draftId: params.draftId,
        });
        const data = result?.data && typeof result.data === "object" ? result.data : result;
        return {
            articleId: data?.articleId ?? 0,
            draftId: data?.draftId ?? params.draftId,
            status: data?.status ?? 0,
        };
    }

    /** 编辑已发布的文章 */
    async editArticle(params: ArticlePayload & { articleId: number; draftId?: number }): Promise<PublishResult> {
        const summary = buildSummary(params.plain);
        const result = await this.request<any>("/api/article/editArticle", {
            articleId: params.articleId,
            title: params.title,
            content: params.content,
            plain: params.plain,
            sourceType: params.sourceType,
            classifyIds: [],
            tagIds: params.tagIds,
            longtailTag: [],
            columnIds: [],
            banComment: 0,
            closeArticleTextLink: 0,
            userSummary: summary,
            pic: "",
            zoneName: "",
            vlogIds: [],
            summary,
            draftId: params.draftId || 0,
        });
        const data = result?.data && typeof result.data === "object" ? result.data : result;
        return {
            articleId: data?.articleId ?? params.articleId,
            draftId: data?.draftId ?? params.draftId ?? 0,
            status: data?.status ?? 0,
        };
    }

    /** 获取 COS 上传信息 */
    async getUploadInfo(extension: string): Promise<ImageUploadInfo> {
        const ext = extension.toLowerCase().replace(/^\./, "");
        return this.request<ImageUploadInfo>("/api/common/cos/upload-info", {
            scene: "column.article",
            extension: ext,
        });
    }

    /** 获取 COS 临时密钥 */
    async getTmpSecret(objectKey: string, durationSeconds = 5400): Promise<CosTmpSecret> {
        return this.request<CosTmpSecret>("/api/common/cos/tmp-secret", {
            objectKey,
            durationSeconds,
        });
    }
}
