#!/usr/bin/env sh
# AuroraTui — POSIX / Git Bash 启动器（mintty 里会自动切到原生控制台窗口）
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/bin/agent.js" "$@"
