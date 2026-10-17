# 开发说明（本 fork）

这个目录**既是 git 仓库，也是 DSH Tavern 实际加载的插件目录**。所以：

- 改完 `client.js` → 刷新页面即生效
- 改完 `lib/*.js`（宿主侧）→ **必须重启 DSH**（ESM 模块缓存撤不掉）

## 日常

```bash
cd <这个目录>          # = profile-data/tavern/data/plugins/dsh-tavern-image
node --test            # 全量测试，改完先跑这个
git add -A && git commit -m "..."
./push.sh https://github.com/你的用户名/<仓库名>.git
```

测试套件是上游自带的（282 个用例），本 fork 新增了 8 个 RunningHub 回归测试。
改 `lib/image-providers.js` 或 `lib/index.js` 之后，跑一遍能挡住大部分回归。

## 从上游同步作者的更新

```bash
git fetch upstream
git log --oneline --no-merges HEAD..upstream/master    # 看作者新提交了什么
git diff HEAD upstream/master -- lib/image-providers.js # 看具体改动
```

然后按需挑：

```bash
# 只挑某个提交
git cherry-pick <commit>

# 或者只想看某个文件的差异后手动合
git diff HEAD upstream/master -- <文件>
```

⚠️ **不要 `git merge upstream/master`**：作者的提交历史是**压成单条 release 提交**的
（`Release 2.5.4.3: ...`），而我们这个仓库的起点是它发布的 tar.gz 快照，两边没有共同
祖先可比。直接 merge 会把几十个重复提交混进来。用 cherry-pick 或手工 diff。

## 三个别踩的坑

1. **不要在插件设置里点"插件更新"**。它的自动更新逻辑是 Git 拉取 `master` 分支，
   会直接覆盖你在本地的改动。要更新时按上面的 cherry-pick 流程手动来。
2. **不要在插件目录跑上游的 `scripts/install-plugin.ps1`**。那套是给"插件装在别处、
   用 DSH CLI 登记"的场景用的；这里是 Tavern 的用户插件目录，会重复安装。
3. **`.gitignore` 里的东西别删**。`config.json` 存的是你的真实 API Key，
   `jobs-store.json` / `worldbook.json` 是你的游玩数据——它们都在忽略列表里，
   推上去不会泄露。新增运行数据文件时记得也加进去。

## 想给上游提 PR

改动都在 6 个提交里，其中两个是可以独立提的：

| 提交 | 内容 | 适合提 PR？ |
|---|---|---|
| `feat(channel)` | RunningHub 渠道 | 是，功能完整、有测试 |
| `fix: 删除记录时摘掉正文插图` | 删记录同步摘媒体项 + 失败记录可见可删 | 是，是两个真 bug |
| `fix(channel): 显式节点映射…` | 配合上面渠道的修正 | 随第一个一起 |
| `chore: import` / `chore: 纳入种子世界书…` | 仓库自身的整理 | 不提 |

提之前先 `git fetch upstream && git log HEAD..upstream/master` 看作者有没有动过
相同文件，避免冲突白做。

## 本 fork 相对上游加的东西

1. **RunningHub 云端 ComfyUI 渠道** —— `lib/image-providers.js` 里的
   `generateRunningHub` / `runninghubBuildNodeInfoList` / `runninghubInferBindings`，
   以及 `client.js` 里渠道表单的那一块。
2. **删除相关的两个修复** —— `lib/tavern-bridge.js` 的 `removeJobMedia` /
   `pruneOrphanMedia`，`lib/index.js` 的 `delete-job` 与 `prune-media` 两个 action，
   `client.js` 的历史图库改动。

配置与用法的细节见 README 的「RunningHub 渠道」一节。
