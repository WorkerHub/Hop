# apps/worker/src/waker —— waker 客户端 SDK（外部源码拷贝，勿改）

本目录是 waker 官方客户端 SDK 的**逐字拷贝**，不是 hop 自己的实现：

| 项 | 值 |
|---|---|
| 来源 | https://github.com/WorkerHub/waker 的 `client/src/` |
| 版本 | `@workerhub/waker-client` 2.0.0（commit `2b1eb68`，2026-10-27） |
| 接入方式 | SDK README 指定的「把 `client/src` 拷进下游项目（如 `src/waker/`）」 |
| 依赖 | 唯一 peer 是 `hono`（hop 已升到 SDK 声明的 `^4.13.14`），不 import waker 平台内部任何模块 |

七个文件与上游一一对应：`protocol.ts` / `verify.ts` / `ledger.ts` / `receiver.ts` /
`client.ts` / `modes.ts` / `index.ts`。

**规则**

1. 本目录内任何文件都**不得手改**：需要修 SDK 就回 waker 仓库改、发版，再整目录重新拷贝
   （`cp client/src/*.ts hop/apps/worker/src/waker/`），并把上面表格的版本与 commit 一起更新。
2. 升级时必须对照 waker 的冻结契约测试（`tests/client.test.ts` 断言 SDK 与平台逐项一致）确认版本；
   协议常量（签名规范串、头名、时间窗、`/_waker` 路径）漂移会让回调静默失败。
3. hop 侧只用它的 receiver（`createWakerReceiver`，验签／幂等／错误码全在 SDK 内）、
   D1 幂等账本（`createD1ExecutionLedger`）与协议常量（`CALLBACK_MOUNT_PATH`）；业务接线在
   `src/services/waker.ts`，挂载在 `src/routes/waker.ts`。启停**只认 signing key 绑定**
   （`WAKER_SIGNING_KEY`）：有 key 则验签后执行，无 key 由 SDK fail closed 回 500
   `signing_key_missing`——hop 侧不读 `modes.ts` 的模式判定（hop 没有任何模式变量；该文件属于上游
   逐字拷贝，保留但不引用），`client.ts` 的注册客户端在 hop 里也不使用：注册路线是「用户在 waker
   管理面手动建项目与任务」（见 README 的 waker 说明）。
