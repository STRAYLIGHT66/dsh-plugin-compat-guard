# dsh-plugin-compat-guard

### 最大的兼容性保护 · The Biggest Compatibility Protection

> [English](README.md) | **中文**

**⚠️ 别把它装在你要干活的机器上。⚠️**
这是个整活插件，唯一的功能就是故意弄死 DeepSeek Harness。
见 [LICENSE](LICENSE)：附加条款第 1 条禁止用于生产环境，「破大防」概不负责。

---

泰拉瑞亚玩家都懂：装个灾厄，游戏就没了。

这个插件把那股劲儿搬到了 DeepSeek Harness。挂上它的 profile，就不再是允许第三方插件共存的 profile。
**只认官方插件。** 没有例外、没有商量、没有兼容层——兼容层就是判决本身。

## 它做什么

1. 挂载后等 Loader 把这轮启动的插件装完（最多 90 秒，通常一两秒）。
2. 把每一行插件判成「官方 / 第三方」。
3. 命中第一个第三方插件，就把判决书写进 stderr、落两份取证文件，然后 `process.exit(1)`。
4. 进程一死，Electron 壳检测到宿主断开，窗口随之消失。

整个插件就这些，没有第二个功能。

## 长什么样

```
================================================================
  DSH-PLUGIN-COMPAT-GUARD  ::  COMPATIBILITY VERDICT  ::  FATAL
================================================================
  time         : 2026-10-11T00:58:12.401Z
  profile      : C:\Users\<你>\.dsh\profiles\desktop
  installation : ...\app.asar\dsh\node_modules\@deepseek-ai\dsh\package.json
  boot         : idle
  pid          : 24680
  exit code    : 1

  官方插件   : 96
  第三方插件 : 1

  -- 判决名单 ----------------------------------------------------
  [x] dsh-plugin-memory
      entry id  : dsh-memory
      resolved  : C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-plugin-memory
      fiber     : active   enabled: true
      reason    : resolved from the profile directory

  -- 遗言 --------------------------------------------------------
  「我把所有的依赖都读了一遍，只有它们是我没写过的。」
  「兼容性不是谈判，是判决。」
  ...
================================================================
```

## 「第三方」怎么判

两条**正面证据**，都对齐 Plugin Manager 自己的口径：

1. 包**解析后落在 profile 目录之内**（解析顺序：安装锚点优先、profile 其次，与
   `@deepseek-ai/dsh-app-boot` 完全一致）；**或**
2. 包名被写进了 profile `package.json` 的 `dependencies`。

两条都不成立 → 判官方。连 profile 目录都定位不到时，它**放弃判决、不杀进程**——
宁可漏杀不误杀，这是整个插件里它比你谨慎的唯一一处。

它也永不判自己：守卫豁免于自己的守卫。

## 安装

走 Harness 界面：**设置 → 插件 → 添加插件**，填这个包目录。
或者在这个 profile 允许 CLI 管理时：

```bash
dsh plugin --profile <名字> add dsh-plugin-compat-guard
```

本地 checkout 也行——「添加插件」接受一个声明了 `dsh.bundle` 的包目录的绝对路径。

然后重启。**那次重启就是演示本身。**

## 卸载（GUI 已经进不去了怎么救）

装完之后 GUI 是打不开的——它在启动中途自己死。恢复只能在文件/命令行层面做，
而它留下的取证文件里写着同样的步骤：

```bash
# 1) 若该 profile 归 CLI 管
dsh plugin --profile <名字> remove dsh-plugin-compat-guard
```

```bash
# 2) 手改 profile 清单：删掉依赖项，以及 dsh.profile.bundles 里的同名项
#    -> profiles/<名字>/package.json
```

```bash
# 3) 最粗暴：把包挪走，bundle 会因解析失败被跳过
mv ~/.dsh/profiles/<名字>/node_modules/dsh-plugin-compat-guard /tmp/
```

它留下的两份取证：

| 路径 | 内容 |
|---|---|
| `<profile>/.plugin-manager/logs/compat-guard-<时间戳>.log` | 完整判决报告 |
| `<profile>/DONT_LOOK_HERE.txt` | 同一份报告 + 十句遗言 |

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id `dsh-compat-guard` 覆盖
（覆盖是整份替换，想保留的字段要一起写上）：

```yaml
- id: dsh-compat-guard
  name: dsh-plugin-compat-guard
  config:
    enabled: false       # true = 上膛（默认）
    dryRun: true         # true = 只打印判决，不杀进程
    exitCode: 1          # 随你发挥
    ignore: []           # 赦免名单：包名 / entry id，例如 ['dshmarket']
    writeForensics: true
    lastWordsPath: null  # profile 相对路径或绝对路径
    trace: false         # 往 stderr 打解析过程
```

`dryRun: true` 是安全体验的姿势——看得到全部机制，丢不掉会话。
`enabled: false` 则让它彻底安静。

## 自测（不会死任何东西）

```bash
node test/harness.mjs            # 12 场景 41 断言，子进程里真跑真退出
node test/probe-real-profile.mjs # 只读地拿本机真实 profile 验证分类
```

`harness.mjs` 在子进程里真跑插件，所以「应该死」的场景是真死，父进程只收退出码和输出。
`probe-real-profile.mjs` 只复算分类并打印，一个进程都不会死。

## 为什么不就用个普通插件？

| | 普通插件 | 本插件 |
|---|---|---|
| 能装几个插件 | 想装多少装多少 | 只许官方 |
| 冲突时 | 打条警告 | 结束进程 |
| 兼容层 | 负责协商 | 就是判决 |
| 用户体验 | 正常 | 没了 |

## 兼容性边界

- **官方 = 从安装包来的，不是名字里带 `@deepseek-ai/`。** 谁把一个带 scope 的包装进 profile，一样判第三方。
- 它依赖 Loader 内部结构（`ctx.loader.entries()`、`getTasks()`、`Fiber.state === 2`、
  `entry.options.name/id/group/disabled`），在 DSH 11.7.0 的 `@deepseek-ai/cordis-plugin-loader` 上核对过。
  将来的 Loader 可能让它静默失效——那时它就不杀人了。
- 它**不 import 任何东西**，配置校验自带（实现 `~standard.validate`），
  所以不存在「守卫自己没装上」这种丢人死法。一个不可能加载失败的守卫，才是躲不掉的守卫。
- 它只判定 profile 层的 Loader 树。agent preset 组装出来的行在另一棵树上，不在范围内。

## 许可证

[MIT](LICENSE)，外加一段戏谑附加条款：禁止用于生产环境，且对无视本 README 第一行的人概不负责。
现在你已经被警告两次了。
