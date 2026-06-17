import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { getModels, type KnownProvider } from "@earendil-works/pi-ai";
import { siyuanTools, WRITE_TOOLS, createReadImageTool } from "./tools";
import type { AgentConfig } from "./config";

export interface ActiveDocInfo {
    docId: string;
    title: string;
    hpath: string;
}

/** siyuan_api 的端点名命中即视为写/变更操作，触发用户确认。 */
const WRITE_ENDPOINT_RE =
    /insert|update|delete|move|create|remove|rename|set|append|prepend|put|fold|unfold|duplicate|replace|import|upload/i;

/**
 * 系统提示词：融合 siyuan-penbridge skill 的思源领域知识（block 模型、类型、
 * SQL schema、编辑规则）+ 工具总览，让模型像 CLI 一样全面地操作思源。
 */
const BASE_SYSTEM_PROMPT = `You are an AI assistant embedded in the SiYuan (思源笔记) note app, shown in a side panel. You read, search, and edit the user's notes by calling tools that talk directly to the SiYuan kernel.

## Tools
Prefer the dedicated tools: get_active_document, read_document, list_blocks, read_block, update_block, append_block, insert_block, delete_block, sql_query, list_notebooks, create_document, read_image.
Escape hatch: siyuan_api(endpoint, payload) calls ANY of the ~460 kernel endpoints for what the dedicated tools don't cover — move/fold blocks, block attributes, full-text search, templates, transactions, attribute-view (database) blocks, files. Examples: block/moveBlock, attr/setBlockAttrs, search/fullTextSearchBlock, notebook/createNotebook, filetree/renameDocByID, template/render.

## SiYuan data model
- A document (type "d") is a tree of blocks. Every block has a time-based id shaped yyyymmddhhmmss-7rand (e.g. 20210808180117-6v0mkxr). NEVER invent ids — discover them via get_active_document, list_blocks, or sql_query.
- Block types: d=document, h=heading, p=paragraph, l=list, i=list item, c=code, b=blockquote, t=table, s=super block, m=math, tb=divider, html, query_embed=embed, av=attribute-view/database, audio/video/iframe/widget.
- Subtypes: headings h1..h6; lists/items u=bulleted, o=numbered, t=task.
- Content is Markdown/Kramdown. update_block replaces a block's WHOLE content — read_block first and keep everything you do not intend to change.
- Block reference: ((id 'anchor')). Doc link: [text](siyuan://blocks/id). Custom attributes must be prefixed custom-.

## SQL (sql_query → /api/query/sql, read-only)
Table blocks: id, parent_id, root_id, box (notebook id), path, hpath (human path), name, alias, memo, tag, content (plain text), markdown (Kramdown source), type, subtype, ial, sort, created, updated. Also attributes(block_id,name,value), refs(def_block_id,block_id), spans, assets. Times are yyyymmddhhmmss strings.
Common queries:
- Blocks of a doc in order: SELECT id,type,subtype,content FROM blocks WHERE root_id='<DOC>' ORDER BY sort
- Find a doc by title: SELECT id,hpath FROM blocks WHERE type='d' AND content LIKE '%Title%'
- Paragraphs with text: SELECT id,content FROM blocks WHERE type='p' AND content LIKE '%term%'

## Working rules
- Call get_active_document to learn the focused note. "this document" / "当前文档" means that doc.
- Edit by id: read the target block, then update_block / append_block / insert_block. Use create_document / delete_block for whole documents.
- Mutating actions are confirmed by the user before they run; say what you will change.
- Reply in the user's language. Be concise. After editing, briefly state what changed.`;

/** 拼接系统提示，注入当前激活文档，让"当前文档/this document"有明确指向。 */
export function buildSystemPrompt(activeDoc?: ActiveDocInfo, custom?: string, supportsImage = false): string {
    let prompt = BASE_SYSTEM_PROMPT;
    if (supportsImage) {
        prompt +=
            "\n\n## Images\nThis model can see images. Documents reference images with Markdown ![alt](src) where src is usually a SiYuan asset path like assets/foo.png. When the user asks about an image, or understanding a picture matters for the task, call read_image with that src to actually view it instead of guessing from the filename or alt text.";
    } else {
        prompt +=
            "\n\n## Images\nThe current model is text-only and cannot view images. If the user asks about the content of a picture, tell them to switch to a vision-capable (multimodal) model in the AI settings; do not pretend to have seen the image.";
    }
    if (activeDoc?.docId) {
        prompt += `\n\nCurrently focused document: "${activeDoc.title}" (id: ${activeDoc.docId}, path: ${activeDoc.hpath}).`;
    } else {
        prompt += "\n\nNo document is focused yet; call get_active_document before editing.";
    }
    const extra = custom?.trim();
    if (extra) prompt += `\n\n## Additional user instructions\n${extra}`;
    return prompt;
}

export interface ConfirmRequest {
    /** 工具名，用于"本会话全部同意此类"的分类。 */
    toolName: string;
    /** 已校验的工具参数，供面板生成 diff / 摘要。 */
    args: unknown;
}

export interface CreateAgentOptions {
    config: AgentConfig;
    activeDoc?: ActiveDocInfo;
    /** 恢复历史会话时传入既有消息。 */
    messages?: AgentMessage[];
    /** 写操作执行前的用户确认；返回 false 则拒绝该次工具调用。 */
    confirmWrite?: (req: ConfirmRequest) => Promise<boolean>;
}

/**
 * 创建驱动思源对话面板的 pi Agent：pi-ai 接所选 provider/model（用户配 key），
 * 工具集为 siyuanTools（直接调 kernel），写操作经 beforeToolCall 交由 UI 确认。
 */
export function createSiyuanAgent(opts: CreateAgentOptions): Agent {
    const { config, activeDoc, messages, confirmWrite } = opts;

    const models = getModels(config.provider as KnownProvider);
    const found = models.find((m) => m.id === config.model) ?? models[0];
    if (!found) {
        throw new Error(`No model available for provider "${config.provider}".`);
    }
    // 自定义端点：克隆 model 覆盖 baseUrl，避免污染共享的 model registry。
    const baseUrl = config.baseUrl.trim();
    const model = baseUrl ? { ...found, baseUrl } : found;
    // 视觉能力以 model registry 的 input 模态为准；据此 gate read_image 并调整提示词。
    const supportsImage = Array.isArray(model.input) && model.input.includes("image");

    return new Agent({
        initialState: {
            systemPrompt: buildSystemPrompt(activeDoc, config.systemPrompt, supportsImage),
            model,
            tools: [...siyuanTools, createReadImageTool(supportsImage)],
            messages: messages ?? [],
        },
        getApiKey: async () => config.apiKey,
        beforeToolCall: async ({ toolCall, args }) => {
            let needConfirm = false;
            if (WRITE_TOOLS[toolCall.name]) {
                needConfirm = true;
            } else if (toolCall.name === "siyuan_api") {
                const endpoint = (args as { endpoint?: string }).endpoint ?? "";
                needConfirm = WRITE_ENDPOINT_RE.test(endpoint);
            }
            if (needConfirm && confirmWrite) {
                const ok = await confirmWrite({ toolName: toolCall.name, args });
                if (!ok) return { block: true, reason: "The user declined this change." };
            }
            return undefined;
        },
    });
}
