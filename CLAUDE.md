# PenBridgeSiyuan — 思源笔记发布插件

## 项目目标

思源笔记（SiYuan）插件，将当前文档一键发布到**腾讯云开发者社区**：

1. **设置页面**：配置腾讯社区授权（Cookie 粘贴 + 校验登录状态）
2. **顶栏按钮（titlebar/topbar）**：点击后对当前打开的文档执行快速发布（标签选择 → 创建/更新草稿 → 发布）

## 周边目录说明（工作区根目录 = 本目录的上级）

| 目录 | 说明 |
|------|------|
| `penBridge/` | 多端发布软件（Electron + Web + Server），**腾讯社区 API 的参考实现来源** |
| `plugin-sample-vite-svelte/` | 思源插件 vite+svelte 模板，**本项目基于此模板搭建** |
| `plugin-sample/` | 思源插件官方 webpack 模板（仅参考） |
| `siyuan/` | 思源笔记源码（查内核 API 用） |
| `PenBridgeSiyuan/` | **本项目** |

### penBridge 关键参考文件

| 文件 | 内容 |
|------|------|
| `penBridge/docs/tencent-cloud-developer-api.md` | 腾讯社区 API 文档 |
| `penBridge/packages/server/src/services/tencentApi.ts` | 核心 API 客户端（~900 行，所有接口封装） |
| `penBridge/packages/server/src/services/tencentAuth.ts` | Cookie 验证、用户信息 |
| `penBridge/packages/server/src/services/articleSync.ts` | 草稿同步 / 发布流程 |
| `penBridge/packages/server/src/services/imageUpload.ts` | 图片上传 COS（并发数 5） |

## 腾讯云开发者社区 API 要点

- Base URL：`https://cloud.tencent.com/developer`，所有接口 **POST + JSON**
- **认证**：纯 Cookie（非 OAuth）。核心字段：`qcommunity_session`、`uin`（格式 `o{数字}`）；可选 `qcmainCSRFToken`。**绝不能发送 `skey`**（会导致 csrfCode 校验失败），不发 skey 时 `csrfCode` 固定为 `"5381"`（djb2 空串哈希）
- 请求头需带：`Cookie`、`Referer: https://cloud.tencent.com/developer/article/write-new`、`Origin: https://cloud.tencent.com`、浏览器 UA

### 主要接口

| 功能 | 路径 | 关键参数 |
|------|------|---------|
| 创建草稿 | `/api/article/addArticleDraft` | title(≤80字), content, plain(≥140字), tagIds, sourceType |
| 更新草稿 | `/api/article/editArticleDraft` | draftId + 同上 |
| 发布 | `/api/article/addArticle` | draftId, title, content, plain, sourceType(1原创), tagIds(1~5个) → `{articleId, status}` |
| 编辑已发布 | `/api/article/editArticle` | articleId + 同上 |
| 搜索标签 | `/api/tag/search` | keyword, limit → `TagInfo[]{tagId, tagName}` |
| 草稿列表（验证登录） | `/api/article/getUserArticleDrafts` | page, pageSize |
| 创作中心列表（含拒绝原因） | `/api/creator/articleList` | hostStatus, page, pageSize → `rejectInfo.reason` |
| 图片上传 | `/api/upload/getUploadInfo` → `/api/upload/getTmpSecret` → COS 直传 | extension / bucket+region+objectKey |

- content 需包裹：`<!--markdown-->\n${md}\n<!--/markdown-->`
- plain = 去除 Markdown 语法的纯文本（也用于生成摘要）
- 发布状态 status：0 审核中 / 1 已发布 / 2 未通过

## 思源插件 API 要点（来自 plugin-sample-vite-svelte）

- 插件类继承 `siyuan` 包的 `Plugin`，生命周期：`onload` / `onLayoutReady` / `onunload`
- 顶栏按钮：`this.addTopBar({ icon, title, position: "right", callback })`（在 `onLayoutReady` 中调用）
- 设置存储：`this.loadData(name)` / `this.saveData(name, data)`；模板封装了 `src/libs/setting-utils.ts` 的 `SettingUtils`，或重写 `openSetting()` 用 `Dialog` + Svelte 组件自定义设置面板
- 当前文档：`getAllEditor()[0].protyle.block.rootID` 获取文档 id；标题在 `protyle.title` 或通过 `/api/block/getBlockInfo`
- 导出 Markdown：内核 API `/api/export/exportMdContent` `{id}` → `{hPath, content}`（模板 `src/api.ts` 已封装 `exportMdContent`）
- **跨域请求**：插件前端 fetch 有 CORS 限制，必须走内核转发代理 `/api/network/forwardProxy`（模板 `src/api.ts` 已封装 `forwardProxy(url, method, payload, headers[], timeout, contentType)`，返回 `{status, body, headers...}`），headers 为 `[{Cookie: "..."}]` 形式的对象数组
- 提示：`showMessage(msg)`；对话框：`new Dialog({title, content, width, destroyCallback})` + Svelte 组件挂载

## 技术栈与构建

- vite 5 + svelte 4 + TypeScript，`siyuan` npm 包 1.1.2（external）
- `pnpm dev`：watch 构建到 `dev/`；`pnpm build`：构建到 `dist/` 并打包 `package.zip`
- 产物：`index.js`(cjs) + `index.css` + `plugin.json` + `i18n/*.json` + `icon.png` + `preview.png` + `README.md`
- 开发联调：`pnpm make-link`（Windows 用 `make-link-win`）将 `dev/` 软链到思源工作空间 `data/plugins/penbridge-siyuan`
- i18n：`public/i18n/*.yaml` 构建时转 json（zh_CN / en_US）

## 项目结构（规划）

```
PenBridgeSiyuan/
├── CLAUDE.md              # 本文件
├── plugin.json            # 插件清单（name: penbridge-siyuan）
├── package.json           # pnpm 脚本与依赖
├── vite.config.ts         # 同模板（lib cjs 构建 + zip 打包）
├── svelte.config.js / tsconfig.json / yaml-plugin.js
├── public/i18n/           # zh_CN.yaml, en_US.yaml
├── scripts/               # make_dev_link.js 等（拷自模板）
├── icon.png / preview.png
└── src/
    ├── index.ts           # 插件入口：onload 注册设置+载入调度器、onLayoutReady 加 topbar+启动调度
    ├── index.scss
    ├── api.ts             # 思源内核 API 封装（request/exportMdContent/forwardProxy/pushMsg）
    ├── scheduler.ts       # 定时发布调度器：任务持久化（scheduled-tasks）、30s 轮询、重启恢复、到期补发、subscribe 通知 UI
    ├── tencent/
    │   ├── client.ts      # 腾讯社区 API 客户端（基于 forwardProxy 移植 tencentApi.ts）
    │   ├── publish.ts     # 共享发布管道 runPublishJob（图片上传→草稿→发布→记录），手动/定时发布共用；PublishError 带 stage
    │   ├── markdown.ts    # wrapMarkdownContent / extractPlainText
    │   └── types.ts       # TagInfo / PublishResponse / TencentConfig 等
    ├── platforms/
    │   └── registry.ts    # 平台注册表（tencent 已支持；huawei/yuque/cnblogs 占位"即将支持"）
    ├── components/
    │   ├── settings.svelte        # 设置面板骨架：左侧导航（发布平台 + 管理/定时任务）+ 右侧面板（720×480 Dialog），支持 initialTab
    │   ├── platform-tencent.svelte # 腾讯云配置面板：Cookie 输入、浏览器登录、验证保存、状态徽标
    │   ├── publish-dialog.svelte # 发布对话框：标题、标签搜索选择、原创声明、立即/定时发布切换（datetime + 快捷预设）
    │   └── task-list.svelte      # 定时任务视图：任务列表/状态徽标/立即发布/取消/重试/删除/清除已结束
    └── libs/              # setting-utils.ts / dialog.ts（拷自模板）
```

## 核心流程

### 授权设置
1. 桌面端"浏览器登录"（src/tencent/browserLogin.ts）：`window.require("@electron/remote")` 开独立分区（persist:penbridge-tencent-login）登录窗加载 cloud.tencent.com/developer，1s 轮询 session cookies 检测 `qcommunity_session`+`uin` → 过滤 skey 拼串自动回填并触发验证保存；非桌面环境（browser-*/mobile）降级为手动粘贴
2. 手动方式：用户在浏览器登录 cloud.tencent.com，复制 Cookie（至少含 `qcommunity_session`、`uin`）
3. 设置面板粘贴 → "验证" 按钮调用 `getUserArticleDrafts(1,1)` 校验 → 成功后 `saveData` 持久化

### 快速发布（顶栏按钮）
1. 点击顶栏按钮弹出平台选择菜单（Menu）：列出 registry 中所有平台，未支持的 disabled 显示"即将支持"
2. 选择腾讯云社区 → getActiveEditor 取当前激活 tab 文档 rootID，无文档则提示
3. `exportMdContent(rootID)` 导出 Markdown，标题取 hPath 末段
4. 弹出发布对话框：编辑标题、搜索并选择标签（1~5 个）、选择 sourceType
5. 图片上传 → 创建草稿 → 发布（已发布过则 editArticle 更新），全部经 `forwardProxy` 转发
6. 按文档 id 记录 `{draftId, articleId}` 到插件数据，支持重复发布即更新
7. 错误处理：src/logger.ts 统一 console 日志（[PenBridge] 前缀，不打敏感信息）；发布按 stage（图片上传/草稿同步/发布）标注错误来源；status===2 审核未通过显式提示

### 定时发布（src/scheduler.ts）
1. 发布对话框选「定时发布」→ 选时间（datetime-local + 快捷预设：1 小时后/今晚 20:00/明早 9:00）→ 创建任务并持久化到 `scheduled-tasks`
2. 调度器 30s 轮询到期任务，到期后**重新导出文档最新内容**经共享管道 runPublishJob 发布；多任务到期串行执行
3. 重启恢复：onload 载入任务、`running` 中断态重置为 `pending`；onLayoutReady 启动轮询并**立即检查一次**，补发关闭期间到期的任务
4. 任务状态机：pending → running → success / reviewing（平台审核中）/ failed；pending 可取消（canceled）、可手动「立即发布」；failed 可重试
5. 任务视图：设置对话框「管理 → 定时任务」标签页（task-list.svelte），顶栏菜单「定时任务（n）」直达；调度器 subscribe 推送变更，UI 实时刷新

## 注意事项

- 发布校验：标题 ≤80 字、纯文本 ≥140 字、标签 1~5 个
- Cookie 中含 skey 时必须过滤掉再发送
- 图片：已实现（src/tencent/imageUpload.ts）——发布前自动检测 markdown 中的思源 assets 图与内联 base64 图，经 `getUploadInfo`(/api/common/cos/upload-info) → `getTmpSecret`(/api/common/cos/tmp-secret) → forwardProxy PUT（payloadEncoding:"base64"）直传 COS（Web Crypto 实现 sha1 签名），公有桶返回裸 URL、私有桶返回带 GET 签名 URL，同源去重、并发 3
- 顶栏发布取"当前激活 tab"文档：getActiveEditor 三级兜底（光标选区 → .layout__wnd--active 中可见 editor → 首个可见 editor）
- forwardProxy 的 payload 是对象，contentType 用 `application/json`；上传二进制时 payload 传 base64 字符串并带 `payloadEncoding: "base64"`
