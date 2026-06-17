/** 对话面板的模型配置。apiKey 存本地插件数据，仅本机使用。 */
export interface AgentConfig {
    /** pi-ai provider id，如 anthropic / openai / google / xai */
    provider: string;
    /** 该 provider 下的 model id */
    model: string;
    /** 该 provider 的 API key（浏览器/渲染进程下必须显式提供） */
    apiKey: string;
    /** 自定义 API 端点（中转/兼容服务）；留空使用 provider 默认。 */
    baseUrl: string;
    /** 追加到内置系统提示词之后的自定义提示词；留空则只用内置。 */
    systemPrompt: string;
}

export const AI_CONFIG_KEY = "ai-config";

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
    provider: "anthropic",
    model: "",
    apiKey: "",
    baseUrl: "",
    systemPrompt: "",
};
