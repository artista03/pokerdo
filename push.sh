#!/bin/bash
# スマホ版をGitHubへ反映する。
#
# アプリ側が sync.json をGitHub APIで直接書き込むので、
# リモートは常にこちらより先に進んでいる。だから push の前に必ず pull が要る。
#
# 🚨 順番が重要：**コミットが先、pullが後**。
#    未コミットの変更が残っていると `git pull --rebase` は
#    「cannot pull with rebase: You have unstaged changes」で止まる。
#
#   bash push.sh              … 既定のメッセージで反映
#   bash push.sh "説明文"      … メッセージを指定
set -e
cd "$(dirname "$0")"

MSG="${1:-スマホ版を更新（解説・回答の反映）}"

if [ -n "$(git status --porcelain)" ]; then
  echo "▶ ローカルの変更をコミット"
  git add -A
  git commit -m "$MSG"
else
  echo "  ローカルに新しい変更は無い"
fi

echo "▶ リモートの更新（スマホが書いた sync.json）を取り込む"
git pull --rebase

echo "▶ push"
git push

echo
echo "✅ 反映した。スマホでリロードすれば新しい解説と回答が出る。"
echo "   https://artista03.github.io/pokerdo/"
