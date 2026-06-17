import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** 一条持久化的对话会话（存于插件数据 ai-sessions）。 */
export interface ChatSession {
    id: string;
    title: string;
    messages: AgentMessage[];
    updatedAt: number;
}

export const SESSIONS_KEY = "ai-sessions";
