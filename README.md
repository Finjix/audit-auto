# audit-auto

AI 审片插件（Codex 插件，给 [lark-agent](https://github.com/Finjix/lark-agent) 用，也能被 Codex 桌面版加载）。用户在飞书里把广告素材（视频、图片或 zip）发给机器人，说明是 GOF 还是 GOT 的素材（没说就先问），插件用 Gemini 按该项目的审片规范逐秒审，按时间顺序返回问题表格：**级别 / 位置 / 问题 / 怎么改**。从头重写，不沿用以前的版本。

三个技能：

| 技能 | 做什么 |
|---|---|
| `gof-audit` | GOF（无尽冬日）审片。固定规范在 `skills/gof-audit/references/rules.md`，取自《无尽冬日 广告素材审核标准（2026-10 版）》 |
| `got-audit` | GOT 审片。固定规范还没有，`rules.md` 是占位，只用动态规范；动态规范也是空的时候拒绝审，并告诉用户先去审核群开始监听 |
| `dynamic-rules` | 动态规范。在业务群里 @机器人「监听本群更新审片规范」，机器人读群里最近一年的聊天，把审核结论整理成该项目的动态规范；之后每天读一次新消息，新增、修改或撤回规范。也能停止（取消）监听、立即更新、查看规范、列出监听的群、删错的规则 |

审片时固定规范和动态规范一起用，两者冲突时以动态规范为准（更新）。

## 目录

```
.agents/plugins/marketplace.json     本仓库就是一个 marketplace（名字 audit-auto）
plugins/audit-auto/                  插件本体，安装和打包的就是这个目录
  plugin.json                        插件清单（Agent Plugins 1.0.0）
  lark-agent.json                    lark-agent 的定时任务：每天（1440 分钟）rules sync
  server/dist/audit.mjs              命令行的打包产物（含 Google Gen AI SDK，提交入库，装好即用）
  skills/gof-audit/                  技能 + references/rules.md（GOF 固定规范）
  skills/got-audit/                  技能 + references/rules.md（占位）
  skills/dynamic-rules/              技能
dev/                                 开发专用，不进入发布包
  audit-sdk/                         TypeScript 源码、esbuild 脚本、测试
  package_plugin.mjs                 插件结构检查和打包
docs/lark-agent-integration.md       放进 lark-agent
```

## 审片怎么做

- **模型**：内部 AI 网关的 Gemini，`https://lumos.diandian.info/winky/gemini/v1/models/gemini-3.8-flash:generateContent`，思考强度 medium。用 Google Gen AI SDK（`@google/genai` 2.32.0），打包进 `server/dist/audit.mjs`，插件不用另装任何东西。
- **key**：和 lark-agent 的 Codex 用的是同一个：从 `CODEX_HOME/config.toml`（lark-agent 的 `.codex/config.toml`）里内部网关那个 provider 的 `experimental_bearer_token` 读，以 `x-goog-api-key` 发给网关。key 不出现在任何输出里；模型（Codex）不用、也不该去读它。
- **视频怎么发**：网关没有 Files API（实测 404），视频 base64 内联发送（实测 112 MB 的视频能过）。超过 40 MB 的视频，本机有 ffmpeg（`FFMPEG` 或 PATH 里的 ffmpeg）就先压成 720p（短边 720、最多 30 帧、H.264 + AAC）再发：Gemini 本来就会把每帧缩小，720p 不丢信息，68 MB 的原片要传 76 秒，压完几秒。没有 ffmpeg 就发原文件，最大 150 MB。MKV 这类 Gemini 不收的格式要先转码。
- **怎么看**：媒体分辨率 high；每秒看几帧按时长定（40 秒内 4 帧，越长越少，最少 1 帧），时长和横竖版从 MP4/MOV 的文件头读，不需要 ffprobe。
- **怎么审**：系统提示词（英文）里放项目的固定规范和动态规范（中文原文），先逐字写出所有字幕、画面文字、口播、台词，再对照规范列问题；每条问题有级别（红线 / 要改 / 需确认）、时间、画面位置或音轨、问题、依据的规则、怎么改。文件名按规范格式起的，也查命名。
- **返回**：渲染成 Markdown 表格（每个文件一张，列是 级别 / 位置 / 问题（原文） / 怎么改，见下），技能让 Codex 原样回复。完整结果（含逐字稿）存在 `user/<名>/audit-auto/reviews/`（不在工作目录，不会被当成交付文件发出去），追问时用。
- **JSON 模式、不用 response schema**：用 `responseJsonSchema` 约束输出时，gemini-3.8-flash 在长的中文字段里会陷入重复，丢掉大部分结果（2026-11-02 实测：13 条消息只整理出 1 条、还是一串重复的字）；只用 JSON 模式、把结构写在提示词里，结果完整（同样的消息整理出 6 条）。所以两处都是 JSON 模式，回答按宽松的方式读。网关也不接受 schema 里的 `maxItems`。
- **安全过滤关掉**：审的就是可能违规的素材（血、赌博机、暴露），被过滤反而看不到问题。

一次最多 30 个素材（zip 里的也算），两个一起审，一个视频大约一分钟。

```
**GOFCN55948_….mp4**（竖版 · 11 秒 · 真人实拍）
演员林子聪先后在工地场景和影棚里喊要玩《无尽冬日》。
结论：改完再送审（红线 1 · 要改 2 · 需确认 1）

| 级别 | 位置 | 问题（原文） | 怎么改 |
|---|---|---|---|
| 需确认 | 全片画面 | 明星林子聪出镜，需确认肖像授权〔明星素材〕 | 投前跟投放确认授权材料已经在账户里 |
| 红线 | 00:00–00:03 画面中下（皮带扣） | 露出古驰双 G 标志〔红线 · 侵权〕 | 打码或裁掉 |
| 要改 | 00:06–00:07 台词 | 「三分钟上头」，「上头」是防沉迷禁用词〔字幕和口播 · 防沉迷〕 | 换成「三分钟就会」这类说法 |
```

## 动态规范怎么做

- **开始**：在群里 @机器人「监听本群更新审片规范」。只能在群里（lark-agent 给插件 `LARK_AGENT_CHAT_ID` / `LARK_AGENT_CHAT_TYPE`）；要说明是哪个项目的审核群，没说就先问。登记这个群，然后马上读最近一年（或用户说的日期起）的群消息，读完回复几句话：读了多少条、整理出几条规范；不附规范文件（要看时 @机器人「看看 GOT 的动态规范」）。
- **读群**：用机器人自己的应用身份（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`，tenant token），不需要用户登录。机器人自己的消息、系统消息、撤回的、表情不读；图片（比如拒审截图）一起交给模型（附不上的，比如转发的聊天记录里的图，标「没能附上」）；转发的聊天记录展开读；回复标明回复的是哪条，回复的是以前读过的消息时，把那条消息（连图）一起带上，标「之前的消息」；发言人显示飞书名字。之后每天读新消息时，先带上上次读到的最后 20 条（每条最多 300 字，不带图），标「之前的消息」，让「那个也不行」这种不点回复的接话也看得懂；只依据之前的消息的操作不采纳（那些消息上次已经整理过）。
- **话题**：飞书把话题（thread）里的回复只列在话题里、不列在群消息里，所以每个群记着它的话题：从话题首条被读到起，每次都去话题里读上次之后的新回复，话题 14 天没有新回复就不再跟。某个话题这次读不到，它的进度不动，下次再读。
- **整理**：每段（约 4 万字、最多 24 张图、图片合计不超过 16 MB）调一次 Gemini，模型看到固定规范、当前的动态规范（每条带依据的原话，最多两句）和这段聊天，给出操作：新增、修改、撤回，每个操作都要指明依据的消息。每段做完就保存，失败了下次从断点接着读。网关暂时不可用（5xx、限流、超时、连不上）或不接受 key、找不到模型（401、403、404）就原样等下次；别的失败（模型拒收某张图、回答不完整）先去掉图片再试一次，同一段连续 3 次都失败就跳过它，记在 `rules status` 的 `skipped` 里，群照常往下读。
- **时间**：用户开始监听时最多读 15 分钟就回复（没读完的 `pending`，交给定时任务接着读）；定时任务每次最多读 15 分钟（之后不再开始新的一段；一次调用最长 10 分钟，lark-agent 30 分钟就结束它），最久没读的群先读，时间用完时还没读到的群下次排在前面；没有新消息（新来的只有机器人自己的回复、表情这类）就不调模型；每个群一次最多 40 段。
- **之后**：lark-agent 每天跑一次 `rules sync`（`lark-agent.json`，`everyMinutes` 1440：服务启动后不久先跑一次，之后每 24 小时一次，不是固定钟点；想马上更新就 @机器人「现在更新一下规范」），读每个群上次之后的新消息和跟着的话题。没有新消息就不调模型。所有群都读失败时退出码 2（日志记「插件定时任务失败」）。定时任务不经过 Codex，只读不发：输出只进 lark-agent 的日志，不在群里发消息；机器人只在有人 @ 它时才在群里回复。
- **存放**：`shared/audit-auto/`（lark-agent 的 `LARK_AGENT_SHARED_DIR`，所有用户共用，不清理、不发送）：`groups.json`（监听的群、读到哪了、跟着的话题、跳过的段）、`rules/<项目>.json` 和 `rules/<项目>.md`（动态规范）、`names.json`（成员名字）、`lock`（同一时间只有一个进程改规范，锁里有持有者的随机令牌，续期和释放只动自己的锁；持有者死了或 10 分钟没续期就被接管；定时任务碰到别人持有就跳过这一次）。
- **规范的样子**：每条规范有编号（D1、D2…，不复用）、分类（和固定规范的章节一致）、规则、怎么改、例子、依据（哪天谁说的）。撤回的和用户删掉的也留着记录。

## 命令

`audit` = `node plugins/audit-auto/server/dist/audit.mjs`。工作时进度写到 stderr，结果是 stdout 的一行 JSON；拒绝或失败时退出码 2（`{"status":"blocked","reason":…}`）。Codex 会把太长的输出从中间截掉，所以 `review` 的输出里 `status`、`result_file` 在最前、`markdown` 在最后：截掉了也能从 `result_file` 读全。

| 命令 | 做什么 |
|---|---|
| `review --project GOF\|GOT --file <路径> [--file …] [--note <用户的说明>]` | 审片；zip 会解压（到 `user/<名>/audit-auto/tmp/`，用完就删） |
| `rules watch --project GOF\|GOT [--since YYYY-MM-DD]` | 开始监听这一轮的群，马上读历史 |
| `rules unwatch` | 停止监听这一轮的群（已有的规范保留） |
| `rules sync [--here]` | 读所有群（或这个群）的新消息；定时任务跑的就是它 |
| `rules status` | 监听的群、每个项目的规范条数 |
| `rules show --project GOF\|GOT [--output <x.md>]` | 动态规范的 Markdown：给 `--output` 就写成文件给用户（已有同名文件就加 (2)），不给就放在输出的 `markdown` 里（不留文件） |
| `rules remove --project GOF\|GOT --id D3 [--id …]` | 删掉错的规则 |
| `doctor` / `info` | 自检（规范文件、AI 网关、飞书应用、共享目录、ffmpeg、群的读取状态）/ 配置（不含 key） |

管理员可以在 lark-agent 的 `.env` 里覆盖：`AUDIT_AUTO_GEMINI_MODEL`、`AUDIT_AUTO_GEMINI_THINKING`、`AUDIT_AUTO_GEMINI_BASE_URL`、`AUDIT_AUTO_GEMINI_KEY`、`FFMPEG`。

## 飞书应用权限

审片不用飞书接口（附件由 lark-agent 下载）。动态规范用机器人应用身份读群，需要：

| 权限 | 用途 | 现状（2026-11-02 实测） |
|---|---|---|
| 获取群组中所有消息 `im:message.group_msg` | 读群里所有消息，不只是 @机器人 的 | 已有：能读到群里没 @机器人 的消息 |
| `im:message:readonly` | 下载消息里的图片 | 已有 |
| `contact:user.base:readonly` | 发言人的名字 | 已有 |

缺权限时 `rules watch` 会照样登记这个群，并告诉用户缺哪个权限（管理员开通、发布新版本后，下一次每天的读取时自动重试）。机器人被移出群也会如实说明。

## 规范怎么维护

- **GOF 固定规范**：`skills/gof-audit/references/rules.md`，从飞书文档整理（内容照原文逐条列出；原文的示例图片没带过来，上传送审流程看素材查不了没收录；第六节加了一条「审片不查编号大小」）。标准出新版就照新版改这个文件，重新打包、部署。
- **GOT 固定规范**：`skills/got-audit/references/rules.md` 第一行是 `<!-- audit-auto: placeholder -->`，有这行就只用动态规范。定下来以后删掉这行，照 GOF 的写法写规范。
- **动态规范**：靠群里的聊天。规则错了，在群里说清楚（下一次每天的读取时更新，或 @机器人「现在更新一下规范」），或让机器人删掉（`rules remove`）。

## 安装

需要 Node.js 24+。放进 lark-agent：见 [docs/lark-agent-integration.md](docs/lark-agent-integration.md)。单独给 Codex 桌面版用：

```bash
codex plugin marketplace add <本仓库路径>
codex plugin add audit-auto@audit-auto
```

单独用时没有 `LARK_AGENT_*`：key 从 `~/.codex/config.toml` 读（或 `AUDIT_AUTO_GEMINI_KEY`），共享数据在 `~/.audit-auto/shared/`；监听群需要宿主给出群聊，单独用时做不了。

## 开发与测试

```bash
cd dev/audit-sdk && npm ci             # 一次
npm test                               # 类型检查 → 打包到 plugins/audit-auto/server/dist → node:test → 插件结构检查
```

改了源码要把 `server/dist/audit.mjs` 一起提交。发布：`node dev/package_plugin.mjs --output dev/dist/audit-auto.zip`。

`src/zip.ts` 的读取部分来自 requirement-auto 的 `src/gof/unzip.ts`；`dev/package_plugin.mjs`、`test/helpers/tmp.ts` 来自 feishu-plugin，`test/helpers/zip-writer.ts` 来自 requirement-auto。

## 实测（2026-11-02，本机）

- 网关：`gemini-3.8-flash`、`thinkingLevel: medium`，`Bearer` 和 `x-goog-api-key` 都认；Files API 404；内联 15 MB、68 MB、112 MB 的视频都能过；`systemInstruction`、安全阈值 `OFF`、`maxOutputTokens` 都接受。
- 审片：真实 GOF 素材 3 条（11 秒、6 秒、38 秒 53 MB 的 HEVC，后者先压到 720p）一起审 80 秒；找到口播「三分钟上头」、皮带扣品牌露出、缺玩法提示语、「不用氪」应为「不用氪金」、打假剧情、「从左下角点进去」配手势引导点击、明星（林子聪、代言人李乃文）需确认授权等。
- 动态规范：编造的 13 条审核群聊天整理出 5 条规范（游戏 UI 里的「立即下载」也要打码、BOSS 写首领、「搞钱」、吊带算衣着暴露、片尾 2 秒 logo 定版——把 3 秒的通知和后来的更正合成一条），闲聊和上传通知没进规范；之后一条「logo 定版的要求取消了」把那条撤掉。
- 飞书：用机器人身份读了一个私聊和一个群（只看了消息类型和数量）：分页、机器人自己的消息（`sender.id` 就是应用 ID）排除、富文本、图片下载、成员名字都正常。
- 真实的群（GOT《箭如雨下》，部署到 lark-agent 后在群里 @机器人「监听本群更新审片规范」）：读了 131 条（126 条进模型，分 2 段，图片一起），模型两段都回答没有操作，规范 0 条。这个群聊的是素材怎么做（石头颜色、视距、箭塔造型、3 秒数据），没有拒审和「X 不能用」这类审核结论，0 条是对的；在本机用同样的代码重读一遍，结果一样。

## 已知限制

- 每秒最多看 4 帧，单帧闪错这类问题看不全。
- 转发的聊天记录里的图片飞书不给下载，模型只知道那里有张图。
- 话题 14 天没有新回复就不再跟（要读完它的回复才判断），之后再有人回复读不到；以前读过的消息被回复时，每次最多补读 50 条。
- GOF 标准里引用的《无尽冬日福利设定》《无尽冬日-英雄系统汇总》没有阅读权限，没整理进来：英雄品质、国服是否已上线这类，审片时标「需确认」。
- 群名读不到（应用没有 `im:chat:readonly`），所以要用户说明是哪个项目的审核群。

## 依赖版本

| 依赖 | 版本 |
|---|---|
| Node.js（系统） | ≥ 24 |
| @google/genai | 2.32.0（已打包进 `server/dist`） |
| esbuild / TypeScript / @types/node（开发） | 0.28.2 / 7.0.2 / 24.19.2 |
