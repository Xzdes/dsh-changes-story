# Changelog

## 1.0.1

- The story window scrolls when the story is long (flex `min-height: 0` fix — the body was clipped instead of scrollable) and no longer scrolls the chat behind it.

## 1.0.0

Initial release: plain-language change stories for DeepSeek Harness (tested on DSH 0.2.1-rc.2).

- After each completed turn, a window explains every changed file in beginner-friendly words, written by the session's own model route.
- A 📖 Story button in the turn action strip (next to Copy / 👍 / 👎) reopens any earlier story; the host keeps the last 50 turns per session.
- Bare-facts fallback (`file: +added / -deleted`) when the model is unavailable or answers non-JSON.
- Live "Open automatically" toggle via the volatile `autoOpen` config field; `language` (ru/en/zh UI) and static limits (`maxFiles`, `maxDiffChars`, `maxOutputTokens`, `timeoutMs`, route override).
- Stories survive neither host restarts nor plugin reloads (in-memory only), matching workspace-changes semantics.
