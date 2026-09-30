#!/usr/bin/env bash
# Rebuilds the custom libav.js variant in public/libav/ (the fallback decoder).
# Requirements: an activated Emscripten SDK (emcc on PATH), node, make, curl, git.
# Usage: scripts/build-libav.sh [work-dir]
set -euo pipefail

# libav.js commit the checked-in build was made from (6.10.9 with FFmpeg 9.0; matches @libav.js/types).
LIBAVJS_REF=c05a676d16c1068cce6115594858c50a7ecad4b8
VARIANT=airside
FRAGMENTS='["avformat","avcodec","avfilter","swresample","filter-aformat","filter-anull",
"demuxer-mp4","demuxer-caf","decoder-alac",
"demuxer-ape","decoder-ape",
"demuxer-wavpack",
"demuxer-tak","decoder-tak","parser-tak",
"demuxer-asf","decoder-wmav1","decoder-wmav2","decoder-wmapro","decoder-wmalossless",
"demuxer-dsf","demuxer-iff","decoder-dsd_lsbf","decoder-dsd_msbf","decoder-dsd_lsbf_planar","decoder-dsd_msbf_planar"]'

root=$(cd "$(dirname "$0")/.." && pwd)
work=${1:-"$root/.libav-build"}
mkdir -p "$work"
cd "$work"
if [ ! -d libav.js ]; then
  git clone https://github.com/Yahweasel/libav.js.git
fi
cd libav.js
git fetch origin
git checkout "$LIBAVJS_REF"
npm install --no-audit --no-fund
(cd configs && ./mkconfig.js "$VARIANT" "$(echo "$FRAGMENTS" | tr -d '\n')")
ffmpeg_version=$(sed -n 's/^FFMPEG_VERSION_MAJOR=//p' Makefile).$(sed -n 's/^FFMPEG_VERSION_MINREV=//p' Makefile)
prefix="dist/libav-$(sed -n 's/^LIBAVJS_VERSION_BASE=//p' Makefile).$ffmpeg_version-$VARIANT"
make -j"$(nproc)" "$prefix.mjs" "$prefix.wasm.mjs"
# Refuse to ship anything that pulled in GPL or non-free code.
grep -q 'define CONFIG_GPL 0' "build/ffmpeg-$ffmpeg_version/build-base-$VARIANT/config.h"
grep -q 'define CONFIG_NONFREE 0' "build/ffmpeg-$ffmpeg_version/build-base-$VARIANT/config.h"
mkdir -p "$root/public/libav"
cp "$prefix.mjs" "$prefix.wasm.mjs" "$prefix.wasm.wasm" "$root/public/libav/"
echo "Copied $(basename "$prefix").* to public/libav/"
