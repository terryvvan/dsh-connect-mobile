#!/usr/bin/env bash
# 手机工作台（dsh-connect-mobile）一键安装 —— macOS / Linux
#
# 用法：
#   bash ./install.sh                    # 装进 $DSH_HOME（默认 ~/.dsh）
#   DSH_HOME=/path/.dsh bash ./install.sh
#   bash ./install.sh --copy             # 复制而不是软链
#   bash ./install.sh --uninstall
#
# 做的事（只改 DSH 的 profile，不碰插件代码）：
#   1) <DSH_HOME>/profiles/web/local-plugins/dsh-connect-mobile  -> 本目录
#   2) <DSH_HOME>/profiles/web/node_modules/dsh-connect-mobile   -> 上面那个
#   3) <DSH_HOME>/profiles/web/package.json 补 dependencies 与 dsh.profile.bundles
set -euo pipefail

PKG="dsh-connect-mobile"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="install"
DO_COPY=0

for arg in "$@"; do
  case "$arg" in
    --uninstall) MODE="uninstall" ;;
    --copy)      DO_COPY=1 ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg"; exit 2 ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
if [ ! -d "$DSH_HOME" ]; then
  echo "✗ 找不到 DSH_HOME：$DSH_HOME"
  echo "  先启动一次 DSH 桌面端，或用 DSH_HOME=/path bash ./install.sh"
  exit 1
fi
PROFILE="$DSH_HOME/profiles/web"
PKGJSON="$PROFILE/package.json"
if [ ! -f "$PKGJSON" ]; then
  echo "✗ 找不到 profile：$PKGJSON"
  echo "  先启动一次 DSH 桌面端（会自动生成 profiles/web）。"
  exit 1
fi

LINK_A="$PROFILE/local-plugins/$PKG"
LINK_B="$PROFILE/node_modules/$PKG"

edit_profile() { # $1 = add|remove
  local action="$1"
  local node_bin
  node_bin="$(command -v node || true)"
  if [ -n "$node_bin" ]; then
    "$node_bin" - "$PKGJSON" "$PKG" "$action" <<'JS'
const fs=require('fs'), [p,name,action]=process.argv.slice(2);
const j=JSON.parse(fs.readFileSync(p,'utf8'));
j.dependencies=j.dependencies||{};
j.dsh=j.dsh||{}; j.dsh.profile=j.dsh.profile||{};
j.dsh.profile.bundles=Array.isArray(j.dsh.profile.bundles)?j.dsh.profile.bundles:[];
if(action==='add'){
  j.dependencies[name]='link:./local-plugins/'+name;
  if(!j.dsh.profile.bundles.includes(name)) j.dsh.profile.bundles.push(name);
}else{
  delete j.dependencies[name];
  j.dsh.profile.bundles=j.dsh.profile.bundles.filter(x=>x!==name);
}
fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
console.log('  dependencies[' + name + ']=' + (j.dependencies[name]||'(removed)') + '  bundles=' + j.dsh.profile.bundles.length);
JS
    return 0
  fi

  # 没有 node：用 python3 兜底
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$PKGJSON" "$PKG" "$action" <<'PY'
import json,sys
p,name,action=sys.argv[1:4]
j=json.load(open(p,encoding='utf-8'))
j.setdefault('dependencies',{})
prof=j.setdefault('dsh',{}).setdefault('profile',{})
b=prof.setdefault('bundles',[])
if action=='add':
    j['dependencies'][name]='link:./local-plugins/'+name
    if name not in b: b.append(name)
else:
    j['dependencies'].pop(name,None)
    prof['bundles']=[x for x in b if x!=name]
open(p,'w',encoding='utf-8').write(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
print('  dependencies[%s]=%s  bundles=%d'%(name,j['dependencies'].get(name,'(removed)'),len(prof['bundles'])))
PY
    return 0
  fi
  echo "✗ 既没有 node 也没有 python3，无法安全改写 package.json。"
  echo "  请手动在这一份里加两处："
  echo "    dependencies[\"$PKG\"] = \"link:./local-plugins/$PKG\""
  echo "    dsh.profile.bundles 追加 \"$PKG\""
  exit 1
}

if [ "$MODE" = "uninstall" ]; then
  echo "卸载 $PKG"
  [ -L "$LINK_B" ] && rm -f "$LINK_B" && echo "  已删 node_modules 链接"
  [ -L "$LINK_A" ] && rm -f "$LINK_A" && echo "  已删 local-plugins 链接"
  edit_profile remove
  echo "✓ 已卸载。重启 DSH 桌面端后生效。"
  exit 0
fi

echo
echo "手机工作台 · 安装程序"
echo "插件目录：$SRC"
echo "DSH_HOME：$DSH_HOME"

mkdir -p "$PROFILE/local-plugins" "$PROFILE/node_modules"
rm -f "$LINK_B" "$LINK_A"

if [ "$DO_COPY" = "1" ]; then
  cp -R "$SRC" "$LINK_A"
  echo "  已复制插件到 local-plugins（--copy）"
else
  ln -s "$SRC" "$LINK_A"
  echo "  已建立软链：local-plugins/$PKG -> $SRC"
fi
ln -s "$LINK_A" "$LINK_B"
echo "  已建立软链：node_modules/$PKG -> local-plugins/$PKG"

edit_profile add

if [ ! -f "$LINK_B/lib/index.js" ]; then
  echo "✗ 装完自检失败：$LINK_B/lib/index.js 不存在"
  exit 1
fi

echo
echo "✓ 安装完成"
echo "  插件入口：$LINK_B/lib/index.js"
if [ -f "$SRC/dist/dsh-mobile-clean.apk" ]; then
  echo "  随包 APK：dist/dsh-mobile-clean.apk（$(du -h "$SRC/dist/dsh-mobile-clean.apk" | cut -f1)）"
else
  echo "  ⚠ 随包 APK 未找到（不影响插件；面板里“下载 APK”会失效）"
fi
echo
echo "下一步："
echo "  1. 完全退出并重开 DSH 桌面端（不是关窗口，要退出进程）"
echo "  2. 侧栏页脚出现「手机」按钮，点开就是工作台面板"
echo "  3. 手机装 dist 里的纯净版 APK，扫码或填地址连过来"
echo
echo "卸载：bash ./install.sh --uninstall"
echo
