# 放进 lark-agent

lark-agent（`D:\project\lark-agent`）在启动时把 `plugins/` 下的插件文件夹装进它自己的 Codex。audit-auto 不依赖其他插件：审片只用 lark-agent 下载好的附件和 AI 网关，读审核群用机器人自己的应用身份，都不需要 feishu 插件的用户登录。

## 怎么放

在 lark-agent 目录里：

```bat
start.cmd stop
robocopy D:\project\audit-auto\plugins\audit-auto plugins\audit-auto /MIR
start.cmd
```

- `robocopy` 返回 1 到 7 都是成功；之后更新也用 `/MIR`。
- 日志里出现 `已安装插件`（audit-auto 2.0.0）和 `插件定时任务已就绪`（`audit-auto/rules-sync（每 1440 分钟）`），`http://127.0.0.1:8765/health` 的 `plugins.loaded` 里有 `audit-auto`、`plugins.jobs` 里有 `rules-sync`，就是装好了。之前装过的 1.5.0 会被整体替换。
- 服务运行中复制没有效果，只在启动时扫描。
- 装好后在 Codex 插件缓存里是 `.codex/plugins/cache/lark-agent/audit-auto/2.0.0/`；装好的副本里跑一次 `node server/dist/audit.mjs doctor`（带上 lark-agent 的环境，或者在飞书里让机器人做）可以确认网关、飞书应用和共享目录都通。

## 约定（宿主给插件什么）

| 项目 | 内容 |
|---|---|
| 插件在 Codex 里的名字 | `audit-auto@lark-agent`；技能 `audit-auto:gof-audit`、`audit-auto:got-audit`、`audit-auto:dynamic-rules` |
| 每个用户每一轮的环境变量 | `CODEX_HOME`（读网关 key）、`LARK_AGENT_USER_DIR`（审片的临时文件和结果）、`LARK_AGENT_SHARED_DIR`（动态规范）、`LARK_AGENT_CHAT_ID` / `LARK_AGENT_CHAT_TYPE`（开始和停止监听哪个群；必须是 `group`）、`LARK_AGENT_USER_OPEN_ID`（谁开始监听、谁删了规则）、`FEISHU_APP_ID` / `FEISHU_APP_SECRET`（读群） |
| 定时任务 | `lark-agent.json`：`rules-sync` 每 1440 分钟（每天）`node ${PLUGIN_ROOT}/server/dist/audit.mjs rules sync`，超时 30 分钟。环境是 Codex 没有用户时的那份加 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`LARK_AGENT_SHARED_DIR`（`CODEX_HOME` 也在）。有用户正在开始监听（持有锁）时这次输出 `busy`、退出码 0，下一天再读。输出只进日志，不发给任何人，也不在群里发消息 |
| 附件 | lark-agent 下载到 `user/<名>/workspace/input/`，技能把路径交给 `review --file`；zip 解压到 `user/<名>/audit-auto/tmp/<这一次>/`，用完删掉 |
| 数据位置 | `user/<名>/audit-auto/reviews/`：最近 30 次审片的结果（Markdown 和含逐字稿的 JSON），追问时用；`shared/audit-auto/`：监听的群和动态规范。都不在 `workspace/` 里，所以不会被清理，也不会被当作交付文件发出去 |
| 交付 | 审片结果在回复里；开始监听、立即更新只回复几句话，不发文件；用户要看规范时，`rules show --output` 写进工作目录的 `动态审片规范-<项目>.md` 随回复发给用户 |
| MCP 服务 | 没有，只有命令行 |

## 验收（部署后在飞书里做）

1. 私聊发一条视频，不说项目：机器人应先问 GOF 还是 GOT。
2. 回答 GOF：返回 级别 / 位置 / 问题 / 怎么改 的表格。
3. 回答 GOT（还没有任何动态规范时）：机器人说 GOT 还没有规范，要先在 GOT 审核群里开始监听。
4. 建一个测试群，拉机器人进去，在群里说几条审核结论（如「「搞钱」也不能写」「BOSS 写成首领」），@机器人「监听本群更新审片规范」，回答项目：应回复读了多少条消息、整理出几条规范，不附文件。之后群里不应出现机器人主动发的消息（每天的读取不发消息）。
5. 群里再说一条新结论，@机器人「现在更新一下规范」（不然要等下一天），再让机器人发一次动态规范，应能看到新的那条。
6. 再审一条素材，问题里应能引用到动态规范（`动态规范 D<n>`）。
7. 测完在测试群里 @机器人「停止监听本群」（或「取消监听」）：`rules status` 里不再有这个群，已有的规范保留。
