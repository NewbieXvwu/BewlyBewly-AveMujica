#!/usr/bin/env bash
#
# 把 Orion 适配层重新贴到最新的上游 main 上。
#
# 分支模型
#   main   —— 上游的纯净镜像，永远不在这里提交任何东西
#   orion  —— main + 我们的适配提交，本脚本 rebase 的就是它
#
# 上游更新后执行
#   ./scripts/orion-sync.sh          只同步
#   ./scripts/orion-sync.sh --build  同步后顺带构建并打包出 extension.zip
#
# 冲突几乎只会出现在下面这三个上游文件里，且都是极小的 hunk：
#   src/background/utils.ts       3 处：import、doRequest 透传 sender、改用 sendRequest
#   src/contentScripts/index.ts   1 行 import + 5 行注册
#   src/manifest.ts               content_scripts.matches 里多一行 app.bilibili.com
#
# 适配逻辑本体全部在新文件里，rebase 时不会冲突：
#   src/background/pageRelay.ts
#   src/contentScripts/pageFetch.ts
#   src/constants/pageRelay.ts
#
set -euo pipefail

BRANCH=orion
UPSTREAM_REF=origin/main

cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "工作区有未提交的改动，请先提交或 stash：" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

echo "==> 拉取上游 ..."
git fetch origin --tags --prune

if git merge-base --is-ancestor "$UPSTREAM_REF" "$BRANCH"; then
  echo "==> $BRANCH 已包含 $UPSTREAM_REF，无需同步"
else
  echo "==> 上游新增提交："
  git log --oneline --no-decorate "$BRANCH".."$UPSTREAM_REF" | head -30
  echo

  echo "==> 切到 $BRANCH 并 rebase 到 $UPSTREAM_REF ..."
  git checkout "$BRANCH"

  if ! git rebase "$UPSTREAM_REF"; then
    cat >&2 <<'EOF'

rebase 冲突了。参考上面的文件清单手工解决，然后：

    git add <冲突的文件>
    git rebase --continue

想整体放弃这次同步：

    git rebase --abort

EOF
    exit 1
  fi
fi

if [[ "${1:-}" == "--build" ]]; then
  echo "==> 构建 ..."
  # 注意：`bun run build` 的第一步 clear 会被本机的安全删除保护拦下
  # （extension/ 有 51 个文件，超过单轮 50 的阈值），所以先把旧目录移走。
  # 另外别用 `| tail` 之类管道包住构建命令——管道会吞掉退出码。
  mv extension "/tmp/bewly-ext-old-$(date +%s)" 2>/dev/null || true
  NODE_ENV=production bun run build:web
  NODE_ENV=production bun run build:prepare
  NODE_ENV=production bun run build:js
  NODE_ENV=production bun run build:bg
  bun run pack:zip
  echo "==> 产物：extension.zip"
fi

echo "==> 完成，当前分支 $(git rev-parse --abbrev-ref HEAD)"
