// 内联 SVG 图标集(lucide-style 24px line icons)。2026-06-09 从 app.js 抽出 ——
// 把纯常量挪进独立模块,app.js 顶部少 ~45 行。零行为变化:app.js 改为
// `import { ICONS } from './icons.mjs'`,其余引用点不动。
//
// All icons share the same stroke / linecap / linejoin attrs so they look
// consistent regardless of where they're embedded. CSS sets the actual
// rendered size (.tag svg { 12px }, .toast svg { 16px }).
//
// _S 是共享 svg attrs,只服务本模块(原 app.js 里块外零引用),故不导出。
const _S = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

export const ICONS = {
  // status icons (used inside .tag chips)
  done:    `<svg ${_S}><polyline points="20 6 9 17 4 12"/></svg>`,
  running: `<svg ${_S}><polygon points="6 3 20 12 6 21"/></svg>`,
  queued:  `<svg ${_S}><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`,
  failed:  `<svg ${_S}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  paused:  `<svg ${_S}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
  // toast icons
  error:   `<svg ${_S}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12.01" y2="16.5"/></svg>`,
  success: `<svg ${_S}><circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/></svg>`,
  info:    `<svg ${_S}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  warning: `<svg ${_S}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  // Maximize / minimize corner arrows (kept for potential reuse)
  maximize: `<svg ${_S}><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
  minimize: `<svg ${_S}><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
  // Lock / unlock — workspace trust state (auto-approve tools or not)
  lock:    `<svg ${_S}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  unlock:  `<svg ${_S}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`,
  // Refresh / sync — used by the per-workspace "Sync skills" button so
  // the user can re-scan ~/.claude/commands + workspace skills after
  // installing a new plugin or editing a command file.
  refresh: `<svg ${_S}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
  // Trash with an arc — "reset session" (forget the conversation history
  // for this workspace's PWA session). Distinct visual from refresh so
  // users don't confuse "sync skills" with "wipe history".
  rewind:  `<svg ${_S}><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
  // Down-arrow with a horizontal lip — "git pull latest". Visually
  // distinct from refresh (which is a circular arrow) so the menu's
  // two "fetch something" actions don't blur together.
  download: `<svg ${_S}><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><line x1="5" y1="20" x2="19" y2="20"/></svg>`,
  // Trash can — "hard delete this workspace" (rm -rf + clean configs).
  // Distinct from rewind: rewind = "wipe history, keep ws"; trash =
  // "everything goes". Red on hover (see style.css).
  trash:   `<svg ${_S}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`,
  // Git branch — 给 worktree 隔离 toggle 用(2026-05-25 加)。
  // Lucide 风格:两个节点 + 一条线 + 弧线表示 branch off。
  branch:  `<svg ${_S}><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`,
  // Three-dot "more" — opens the mobile actions dropdown (trust /
  // sync / reset / delete + provider switch, all collapsed because
  // 6 icons inline are too cramped on phone screens).
  more:    `<svg ${_S}><circle cx="12" cy="12" r="1.5"/><circle cx="6" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/></svg>`,
  settings: `<svg ${_S}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
};
