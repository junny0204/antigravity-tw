#!/bin/bash
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

TARGET_USER="${SUDO_USER:-$(/usr/bin/stat -f%Su /dev/console 2>/dev/null || echo "${USER:-}")}"
USER_HOME="$HOME"
if [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ] && [ "$TARGET_USER" != "loginwindow" ]; then
    DSCL_HOME="$(/usr/bin/dscl . -read "/Users/${TARGET_USER}" NFSHomeDirectory 2>/dev/null | /usr/bin/sed 's/^NFSHomeDirectory: //' || true)"
    [ -n "$DSCL_HOME" ] && USER_HOME="$DSCL_HOME"
fi

# 尋找可用的 Node.js 執行檔（涵蓋 Homebrew、官方安裝包、volta、fnm、mise、asdf、nvm）
NODE_BIN=""
CANDIDATES=(
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "${USER_HOME}/.volta/bin/node"
    "${USER_HOME}/.fnm/current/bin/node"
    "${USER_HOME}/.local/share/mise/shims/node"
    "${USER_HOME}/.asdf/shims/node"
    "$(command -v node 2>/dev/null || true)"
)
if [ -d "${USER_HOME}/.nvm/versions/node" ]; then
    while IFS= read -r nvm_node; do
        [ -n "$nvm_node" ] && CANDIDATES+=("$nvm_node")
    done < <(ls -1d "${USER_HOME}/.nvm/versions/node"/v*/bin/node 2>/dev/null | sort -r)
fi
for cand in "${CANDIDATES[@]}"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
        NODE_BIN="$cand"
        break
    fi
done

if [ -z "$NODE_BIN" ]; then
    echo "❌ 未偵測到 Node.js，請先安裝 Node.js 22.12+（https://nodejs.org/）後再重試。"
    read -n 1 -s || true
    exit 1
fi

NEED_SUDO=0
if [ "$EUID" -ne 0 ]; then
    DETECTED_APP=""
    for app_cand in "/Applications/Antigravity.app" "/Applications/Antigravity IDE.app" "${USER_HOME}/Applications/Antigravity.app" "${USER_HOME}/Applications/Antigravity IDE.app"; do
        if [ -d "$app_cand" ]; then
            DETECTED_APP="$app_cand"
            break
        fi
    done
    if [ -n "$DETECTED_APP" ] && [ ! -w "${DETECTED_APP}/Contents/Resources" ]; then
        NEED_SUDO=1
    elif [ -f "/Library/LaunchDaemons/com.antigravity.autolocalize.plist" ]; then
        NEED_SUDO=1
    fi
fi

if [ "$NEED_SUDO" -eq 1 ]; then
    echo "======================================================"
    echo " 提示：macOS 修改應用程式（/Applications）需要管理員權限"
    echo " 請在下方輸入您的電腦開機密碼（輸入時畫面不會顯示密碼，直接按 Enter）："
    echo "======================================================"
    exec sudo env "PATH=$(dirname "$NODE_BIN"):$PATH" bash "$0" "$@"
fi

# 若背景守護服務正在執行，先自動卸載，避免還原後被背景守護再次自動中文化
if [ -f "/Library/LaunchDaemons/com.antigravity.autolocalize.plist" ] || [ -f "${USER_HOME}/Library/LaunchAgents/com.antigravity.autolocalize.plist" ]; then
    echo "⚡ 偵測到背景自動更新守護服務正在運作。"
    echo "   為防止還原後背景守護再度將其自動重套繁中，正在為您同步停止並卸載守護服務..."
    bash ./uninstall_macos_autowatcher.sh 2>/dev/null || true
    echo ""
fi

echo "======================================================"
echo "    正在還原 macOS 版 Antigravity 官方原版英文"
echo "======================================================"
"$NODE_BIN" localization_engine.js --tw --huifu "$@"

if [ $? -ne 0 ]; then
    echo ""
    echo "❌ 執行失敗！請檢查上方錯誤訊息。"
    read -n 1 -s || true
    exit 1
fi

echo ""
echo "🎉 處理完成！視窗將在 5 秒後自動關閉（或按任意鍵立即關閉）..."
read -t 5 -n 1 -s || true
