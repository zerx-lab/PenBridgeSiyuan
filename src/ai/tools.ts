import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
    exportMdContent,
    updateBlock,
    appendBlock,
    insertBlock,
    deleteBlock,
    getBlockKramdown,
    sql,
    getHPathByID,
    createDocWithMd,
    lsNotebooks,
    request,
} from "../api";
import { getActiveDocId } from "../active-doc";

/** 工具结果统一封装为单条文本块（pi-ai toolResult 内容格式）。 */
function toolText(text: string) {
    return { content: [{ type: "text" as const, text }], details: {} };
}

const ReadDocSchema = Type.Object({
    docId: Type.String({ description: "Root block id of the document (type 'd')" }),
});

const ListBlocksSchema = Type.Object({
    docId: Type.String({ description: "Root block id whose child blocks to list" }),
});

const ReadBlockSchema = Type.Object({
    blockId: Type.String({ description: "Id of the block to read" }),
});

const UpdateBlockSchema = Type.Object({
    blockId: Type.String({ description: "Id of the block to replace" }),
    markdown: Type.String({ description: "New Markdown content for the WHOLE block" }),
});

const AppendBlockSchema = Type.Object({
    parentId: Type.String({ description: "Parent block/document id to append into" }),
    markdown: Type.String({ description: "Markdown content to append as the last child" }),
});

const InsertBlockSchema = Type.Object({
    markdown: Type.String({ description: "Markdown content of the new block" }),
    previousId: Type.Optional(Type.String({ description: "Insert after this block id" })),
    nextId: Type.Optional(Type.String({ description: "Insert before this block id" })),
});

const DeleteBlockSchema = Type.Object({
    blockId: Type.String({ description: "Id of the block to delete (irreversible)" }),
});

const SqlSchema = Type.Object({
    statement: Type.String({ description: "A read-only SQL SELECT over the SiYuan block database" }),
});

const CreateDocSchema = Type.Object({
    notebook: Type.String({ description: "Notebook id (see list_notebooks)" }),
    path: Type.String({ description: "Human path like /Inbox/My Note" }),
    markdown: Type.String({ description: "Initial Markdown content" }),
});

/**
 * 思源 AgentTool 集：pi agent 通过这些工具读写当前思源工作空间。
 * 实现直接走插件已有的 api.ts（同源 kernel，无 CORS、无外部进程）。
 * 写操作不可逆，由对话面板的 beforeToolCall 做用户确认。
 */
export const siyuanTools: AgentTool[] = [
    {
        name: "get_active_document",
        label: "Get active document",
        description:
            "Return the document the user currently has focused in SiYuan (root block id, title, hpath). Call this first to know which note to operate on.",
        parameters: Type.Object({}),
        execute: async () => {
            const docId = getActiveDocId();
            if (!docId) throw new Error("No active document. Ask the user to open a note in SiYuan.");
            let hpath = "";
            try {
                hpath = await getHPathByID(docId);
            } catch {
                // hpath 仅用于展示，取不到忽略
            }
            const title = hpath ? hpath.split("/").pop() ?? "" : "";
            return toolText(JSON.stringify({ docId, title, hpath }));
        },
    },
    {
        name: "read_document",
        label: "Read document",
        description: "Export a whole document as Markdown.",
        parameters: ReadDocSchema,
        execute: async (_id, params) => {
            const { docId } = params as Static<typeof ReadDocSchema>;
            const res = await exportMdContent(docId);
            return toolText(res.content ?? "");
        },
    },
    {
        name: "list_blocks",
        label: "List blocks",
        description:
            "List a document's blocks in order (id, type, content). Use the ids to read or edit specific blocks.",
        parameters: ListBlocksSchema,
        execute: async (_id, params) => {
            const { docId } = params as Static<typeof ListBlocksSchema>;
            const rows = await sql(
                `SELECT id,type,subtype,content FROM blocks WHERE root_id='${docId}' ORDER BY sort`,
            );
            return toolText(JSON.stringify(rows, null, 2));
        },
    },
    {
        name: "read_block",
        label: "Read block",
        description: "Read one block's Markdown (Kramdown) source. Read before you update.",
        parameters: ReadBlockSchema,
        execute: async (_id, params) => {
            const { blockId } = params as Static<typeof ReadBlockSchema>;
            const res = await getBlockKramdown(blockId);
            return toolText(res.kramdown ?? "");
        },
    },
    {
        name: "update_block",
        label: "Update block",
        description:
            "Replace the ENTIRE content of a block with new Markdown. Read the block first and include all of its content.",
        parameters: UpdateBlockSchema,
        execute: async (_id, params) => {
            const { blockId, markdown } = params as Static<typeof UpdateBlockSchema>;
            await updateBlock("markdown", markdown, blockId);
            return toolText(`Updated block ${blockId}.`);
        },
    },
    {
        name: "append_block",
        label: "Append block",
        description: "Append a new Markdown block as the last child of a document or block.",
        parameters: AppendBlockSchema,
        execute: async (_id, params) => {
            const { parentId, markdown } = params as Static<typeof AppendBlockSchema>;
            await appendBlock("markdown", markdown, parentId);
            return toolText(`Appended to ${parentId}.`);
        },
    },
    {
        name: "insert_block",
        label: "Insert block",
        description:
            "Insert a new Markdown block relative to an existing one. Provide previousId (insert after) or nextId (insert before).",
        parameters: InsertBlockSchema,
        execute: async (_id, params) => {
            const { markdown, previousId, nextId } = params as Static<typeof InsertBlockSchema>;
            if (!previousId && !nextId) {
                throw new Error("Provide previousId or nextId to position the new block.");
            }
            await insertBlock("markdown", markdown, nextId, previousId);
            return toolText("Inserted block.");
        },
    },
    {
        name: "delete_block",
        label: "Delete block",
        description: "Delete a block by id. This is irreversible.",
        parameters: DeleteBlockSchema,
        execute: async (_id, params) => {
            const { blockId } = params as Static<typeof DeleteBlockSchema>;
            await deleteBlock(blockId);
            return toolText(`Deleted block ${blockId}.`);
        },
    },
    {
        name: "sql_query",
        label: "SQL query",
        description:
            "Run a read-only SQL SELECT over the SiYuan block database to find blocks by content, type, or position.",
        parameters: SqlSchema,
        execute: async (_id, params) => {
            const { statement } = params as Static<typeof SqlSchema>;
            const rows = await sql(statement);
            return toolText(JSON.stringify(rows, null, 2));
        },
    },
    {
        name: "list_notebooks",
        label: "List notebooks",
        description: "List notebooks (id and name). Needed before creating a document.",
        parameters: Type.Object({}),
        execute: async () => {
            const res = await lsNotebooks();
            return toolText(JSON.stringify(res.notebooks ?? res, null, 2));
        },
    },
    {
        name: "create_document",
        label: "Create document",
        description: "Create a new document in a notebook with initial Markdown. Returns the new doc id.",
        parameters: CreateDocSchema,
        execute: async (_id, params) => {
            const { notebook, path, markdown } = params as Static<typeof CreateDocSchema>;
            const docId = await createDocWithMd(notebook, path, markdown);
            return toolText(`Created document ${docId}.`);
        },
    },
    {
        name: "siyuan_api",
        label: "SiYuan kernel API",
        description:
            "Call ANY SiYuan kernel API endpoint for operations the dedicated tools don't cover — move/fold blocks, block attributes, notebooks, templates, full-text search, transactions, attribute-view (database) blocks, files, etc. `endpoint` is a kernel path like 'block/moveBlock'; `payload` is the JSON request body. This exposes the full ~460-endpoint API (see SiYuan API.md). Prefer the dedicated tools for everyday reads/edits.",
        parameters: Type.Object({
            endpoint: Type.String({
                description: "Kernel API path, e.g. 'block/moveBlock' or '/api/attr/setBlockAttrs'",
            }),
            payload: Type.Optional(
                Type.Record(Type.String(), Type.Unknown(), { description: "JSON request body object" }),
            ),
        }),
        execute: async (_id, params) => {
            const { endpoint, payload } = params as { endpoint: string; payload?: Record<string, unknown> };
            const clean = endpoint.replace(/^\//, "").replace(/^api\//, "");
            const res = await request(`/api/${clean}`, payload ?? {}, "response");
            return toolText(JSON.stringify(res, null, 2));
        },
    },
];

/** 写操作工具名表，对话面板用于"执行前确认"。 */
export const WRITE_TOOLS: Record<string, true> = {
    update_block: true,
    append_block: true,
    insert_block: true,
    delete_block: true,
    create_document: true,
};
