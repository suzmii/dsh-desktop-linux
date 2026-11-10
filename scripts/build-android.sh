#!/usr/bin/env bash
# Build the Android client APK for the dsh desktop shell.
#
# Everything is user-local: the JDK, Android command-line tools, SDK packages and
# Gradle live under $DSH_ANDROID_TOOLCHAIN (default ~/.local/share/dsh-android).
# No root, no Android Studio.
#
#   scripts/build-android.sh              # release APK (debug-signed for sideload)
#   scripts/build-android.sh debug        # debug variant
#
# Reuses an existing JAVA_HOME when it is a JDK 17 and skips downloads that are
# already present, so a second run only rebuilds the app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLCHAIN="${DSH_ANDROID_TOOLCHAIN:-$HOME/.local/share/dsh-android}"
JDK="$TOOLCHAIN/jdk17"
SDK="$TOOLCHAIN/android-sdk"
GRADLE="$TOOLCHAIN/gradle-8.9"
VARIANT="${1:-release}"

JDK_URL="https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/linux/OpenJDK17U-jdk_x64_linux_hotspot_17.0.21_9.tar.gz"
CMDLINE_URL="https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip"
GRADLE_URL="https://downloads.gradle.org/distributions/gradle-8.9-bin.zip"

mkdir -p "$TOOLCHAIN"

say() { printf '\n==> %s\n' "$1"; }

# ── JDK 17 ───────────────────────────────────────────────────────────────────
if [[ ! -x "$JDK/bin/javac" ]]; then
  if [[ -n "${JAVA_HOME:-}" && -x "${JAVA_HOME}/bin/javac" ]]; then
    say "using JAVA_HOME=$JAVA_HOME"
    JDK="$JAVA_HOME"
  else
    say "downloading JDK 17"
    if [[ ! -s "$TOOLCHAIN/jdk17.tar.gz" ]]; then
      curl -fL --retry 3 -o "$TOOLCHAIN/jdk17.tar.gz" "$JDK_URL"
    fi
    mkdir -p "$JDK"
    tar -xzf "$TOOLCHAIN/jdk17.tar.gz" -C "$JDK" --strip-components=1
  fi
fi
"$JDK/bin/java" -version 2>&1 | head -1

# ── Android command-line tools and SDK packages ──────────────────────────────
if [[ ! -d "$SDK/platforms/android-35" || ! -d "$SDK/build-tools/35.0.0" ]]; then
  say "installing Android SDK packages"
  if [[ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]]; then
    if [[ ! -s "$TOOLCHAIN/cmdline-tools.zip" ]]; then
      curl -fL --retry 3 -o "$TOOLCHAIN/cmdline-tools.zip" "$CMDLINE_URL"
    fi
    mkdir -p "$SDK/cmdline-tools"
    unzip -qo "$TOOLCHAIN/cmdline-tools.zip" -d "$SDK/cmdline-tools"
    mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest"
  fi
  export JAVA_HOME="$JDK"
  yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1 || true
  "$SDK/cmdline-tools/latest/bin/sdkmanager" --install \
    "platform-tools" "platforms;android-35" "build-tools;35.0.0"
fi

# ── Gradle ───────────────────────────────────────────────────────────────────
if [[ ! -x "$GRADLE/bin/gradle" ]]; then
  say "downloading Gradle 8.9"
  if [[ ! -s "$TOOLCHAIN/gradle-8.9-bin.zip" ]]; then
    curl -fL --retry 3 -o "$TOOLCHAIN/gradle-8.9-bin.zip" "$GRADLE_URL"
  fi
  unzip -qo "$TOOLCHAIN/gradle-8.9-bin.zip" -d "$TOOLCHAIN"
fi

# ── Build ────────────────────────────────────────────────────────────────────
printf 'sdk.dir=%s\n' "$SDK" > "$ROOT/android/local.properties"
export JAVA_HOME="$JDK"
export ANDROID_HOME="$SDK"
export PATH="$JAVA_HOME/bin:$PATH"

GRADLE_ARGS=(-p "$ROOT/android" --no-daemon "--console=plain")
if [[ -n "${https_proxy:-}" ]]; then
  proxy="${https_proxy#*://}"
  proxy_host="${proxy%%:*}"
  proxy_port="${proxy##*:}"
  GRADLE_ARGS+=(
    "-Dhttps.proxyHost=$proxy_host" "-Dhttps.proxyPort=$proxy_port"
    "-Dhttp.proxyHost=$proxy_host" "-Dhttp.proxyPort=$proxy_port"
    "-Dhttp.nonProxyHosts=localhost|127.0.0.1"
  )
fi

say "building $VARIANT APK"
if [[ "$VARIANT" == "debug" ]]; then
  "$GRADLE/bin/gradle" "${GRADLE_ARGS[@]}" assembleDebug
  APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
  NAME="dsh-desktop-android-0.1.1-debug.apk"
else
  "$GRADLE/bin/gradle" "${GRADLE_ARGS[@]}" assembleRelease
  APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
  NAME="dsh-desktop-android-0.1.1.apk"
fi

mkdir -p "$ROOT/dist"
cp "$APK" "$ROOT/dist/$NAME"
say "artifact"
ls -lh "$ROOT/dist/$NAME"
sha256sum "$ROOT/dist/$NAME"
