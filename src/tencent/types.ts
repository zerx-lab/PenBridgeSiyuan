/**
 * 腾讯云开发者社区相关类型定义
 */

/** 插件保存的腾讯社区配置 */
export interface TencentConfig {
    cookie: string;
    uin?: string;
    nickname?: string;
    /** 上次验证成功的时间戳（ms） */
    verifiedAt?: number;
}

/** 标签信息 */
export interface TagInfo {
    tagId: number;
    tagName: string;
}

/** 草稿创建/更新结果 */
export interface DraftResult {
    draftId: number;
}

/** 发布/编辑文章结果 */
export interface PublishResult {
    articleId: number;
    draftId: number;
    /** 0-审核中, 1-已发布, 2-未通过 */
    status: number;
}

/** 按思源文档 id 存储的发布记录 */
export interface PublishRecord {
    draftId?: number;
    articleId?: number;
    lastPublishedAt?: number;
}

/** COS 上传信息（来自 /api/common/cos/upload-info） */
export interface ImageUploadInfo {
    bucket: string;
    region: string;
    objectKey: string;
    isPrivateBucket: boolean;
}

/** COS 临时密钥（来自 /api/common/cos/tmp-secret） */
export interface CosTmpSecret {
    credentials: {
        TmpSecretId: string;
        TmpSecretKey: string;
        Token: string;
    };
    expiredTime: number;
    startTime: number;
}
