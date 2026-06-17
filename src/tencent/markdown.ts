/**
 * Markdown 处理工具
 */

/** 将 Markdown 包裹为腾讯社区 Markdown 编辑器格式 */
export function wrapMarkdownContent(md: string): string {
    return `<!--markdown-->\n${md}\n<!--/markdown-->`;
}

/** 提取纯文本（用于 plain 字段与字数校验） */
export function extractPlainText(md: string): string {
    return md
        // 代码块
        .replace(/```[\s\S]*?```/g, " ")
        // 行内代码
        .replace(/`([^`]+)`/g, "$1")
        // 图片
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        // 链接（保留文字）
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        // 标题 #
        .replace(/^#{1,6}\s+/gm, "")
        // 粗体 / 斜体
        .replace(/(\*\*|__)([\s\S]*?)\1/g, "$2")
        .replace(/(\*|_)([^*_\n]+)\1/g, "$2")
        // 引用 >
        .replace(/^>\s?/gm, "")
        // 表格分隔线
        .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, " ")
        // 列表标记
        .replace(/^[-*+]\s+/gm, "")
        .replace(/^\d+\.\s+/gm, "")
        // 分隔线
        .replace(/^[-*_]{3,}\s*$/gm, " ")
        // HTML 标签
        .replace(/<[^>]+>/g, " ")
        // 合并空白
        .replace(/\s+/g, " ")
        .trim();
}

/** 生成摘要：取纯文本前 200 字 */
export function buildSummary(plain: string): string {
    return plain.substring(0, 200);
}
