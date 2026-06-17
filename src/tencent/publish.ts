/**
 * 腾讯云社区共享发布管道：图片上传 → 草稿创建/更新 → 发布/编辑 → 更新发布记录
 * 手动发布（publish-dialog）与定时发布（scheduler）共用同一流程
 */
import type { Plugin } from "siyuan";
import { TencentClient } from "./client";
import { wrapMarkdownContent, extractPlainText } from "./markdown";
import { uploadDocImages } from "./imageUpload";
import type { PublishRecord, PublishResult, TencentConfig } from "./types";
import { logger } from "../logger";

export type PublishStage = "config" | "validate" | "uploadImages" | "draft" | "publish";

/** 带阶段信息的发布错误，便于错误提示标注来源 */
export class PublishError extends Error {
    stage: PublishStage;

    constructor(stage: PublishStage, message: string) {
        super(message);
        this.name = "PublishError";
        this.stage = stage;
    }
}

function wrapStage(stage: PublishStage, e: any): PublishError {
    if (e instanceof PublishError) return e;
    return new PublishError(stage, `${e?.message ?? e}`);
}

export interface PublishJobParams {
    docId: string;
    title: string;
    tagIds: number[];
    /** 0-未选择, 1-原创, 2-转载, 3-翻译 */
    sourceType: number;
    markdown: string;
    onUploadProgress?: (done: number, total: number) => void;
}

export async function runPublishJob(plugin: Plugin, params: PublishJobParams): Promise<PublishResult> {
    const i18n: any = plugin.i18n;

    // 配置检查
    const config = (await plugin.loadData("tencent-config")) as TencentConfig;
    if (!config || typeof config !== "object" || !config.cookie) {
        throw new PublishError("config", i18n.needCookie);
    }

    // 参数校验
    const title = params.title.trim();
    if (!title) throw new PublishError("validate", i18n.titleRequired);
    if (title.length > 80) throw new PublishError("validate", i18n.titleTooLong);
    if (params.tagIds.length < 1 || params.tagIds.length > 5) {
        throw new PublishError("validate", i18n.tagsRequired);
    }

    const client = new TencentClient(config.cookie);

    // 上传文档内图片到 COS
    let finalMarkdown: string;
    try {
        finalMarkdown = await uploadDocImages(client, params.markdown, params.onUploadProgress);
    } catch (e: any) {
        throw wrapStage("uploadImages", e);
    }

    // 图片 URL 替换后重算 plain，确保提交内容与 finalMarkdown 一致
    const finalPlain = extractPlainText(finalMarkdown);
    if (finalPlain.length < 140) throw new PublishError("validate", i18n.plainTooShort);

    const content = wrapMarkdownContent(finalMarkdown);
    const payload = { title, content, plain: finalPlain, tagIds: params.tagIds, sourceType: params.sourceType };

    const loaded = await plugin.loadData("publish-records");
    const records: Record<string, PublishRecord> =
        loaded && typeof loaded === "object" ? loaded : {};
    const record: PublishRecord = records[params.docId] ?? {};

    // 创建或更新草稿
    let draftId: number;
    try {
        if (record.draftId) {
            try {
                await client.updateDraft({ ...payload, draftId: record.draftId, articleId: record.articleId });
                draftId = record.draftId;
            } catch {
                // 草稿可能已被删除，创建新草稿兜底
                draftId = (await client.createDraft(payload)).draftId;
            }
        } else {
            draftId = (await client.createDraft(payload)).draftId;
        }
    } catch (e: any) {
        throw wrapStage("draft", e);
    }

    // 发布或更新已发布文章
    let result: PublishResult;
    try {
        if (record.articleId) {
            try {
                result = await client.editArticle({ ...payload, articleId: record.articleId, draftId });
            } catch (e: any) {
                // [11002] 内容不存在：文章已在平台被删除，清除失效 articleId 改为重新发布
                if (!`${e?.message ?? e}`.includes("[11002]")) throw e;
                logger.warn("editArticle: 文章不存在（可能已删除），改为重新发布", record.articleId);
                record.articleId = undefined;
                result = await client.publishArticle({ ...payload, draftId });
            }
        } else {
            result = await client.publishArticle({ ...payload, draftId });
        }
    } catch (e: any) {
        throw wrapStage("publish", e);
    }

    // 重新读取记录再写入，降低并发任务相互覆盖的风险
    const fresh = await plugin.loadData("publish-records");
    const latest: Record<string, PublishRecord> =
        fresh && typeof fresh === "object" ? fresh : {};
    latest[params.docId] = {
        draftId,
        articleId: result.articleId || record.articleId,
        lastPublishedAt: Date.now(),
    };
    await plugin.saveData("publish-records", latest);

    return result;
}
