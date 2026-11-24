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

# 僅在目標應用程式目錄無法由目前使用者直接寫入時才透過 sudo 提權
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

echo "======================================================"
echo "    正在安裝 macOS 版 Antigravity 繁體中文（台灣）套件"
echo "======================================================"
echo ""
echo "請選擇左上角品牌名稱顯示方式："
echo "[1] 顯示官方英文 Antigravity（推薦）"
echo "[2] 隱藏品牌名稱"
echo "[3] 顯示繁體中文品牌名（反重力）"
printf "請輸入 1/2/3（直接按 Enter 預設為 1）："
read -r BRAND_CHOICE
BRAND_ARG="english"
if [ "$BRAND_CHOICE" = "2" ]; then
    BRAND_ARG="hidden"
elif [ "$BRAND_CHOICE" = "3" ]; then
    BRAND_ARG="translated"
fi

"$NODE_BIN" localization_engine.js --tw --brand-title "$BRAND_ARG" --sync-watcher "$@"

if [ $? -ne 0 ]; then
    echo ""
    echo "❌ 執行失敗！請檢查上方錯誤訊息。"
    read -n 1 -s || true
    exit 1
fi

WATCHER_UPDATED=0
SYSTEM_PLIST="/Library/LaunchDaemons/com.antigravity.autolocalize.plist"
USER_PLIST="${USER_HOME}/Library/LaunchAgents/com.antigravity.autolocalize.plist"
if [ -f "$SYSTEM_PLIST" ]; then
    echo ""
    echo "🔄 偵測到本機已啟用系統級背景守護服務，正在同步升級至最新版以防舊版覆寫..."
    bash ./install_macos_autowatcher.sh --daemon && WATCHER_UPDATED=1
elif [ -f "$USER_PLIST" ]; then
    echo ""
    echo "🔄 偵測到本機已啟用使用者級背景守護服務，正在同步升級至最新版以防舊版覆寫..."
    if [ "$EUID" -eq 0 ] && [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ]; then
        sudo -u "$TARGET_USER" HOME="$USER_HOME" bash ./install_macos_autowatcher.sh --user && WATCHER_UPDATED=1
    else
        bash ./install_macos_autowatcher.sh --user && WATCHER_UPDATED=1
    fi
fi

echo ""
echo "🎉 繁體中文套件安裝完成。"
if [ "$WATCHER_UPDATED" -eq 0 ]; then
    echo "💡 說明：若需在 Antigravity 官方更新或詞庫發布時自動維持繁中化，"
    echo "   可執行目錄內的「點兩下安裝macOS背景守護.command」啟用背景服務。"
fi
echo ""
echo "視窗將於 5 秒後自動關閉（亦可按任意鍵立即離開）..."
read -t 5 -n 1 -s || true
