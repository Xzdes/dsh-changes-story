# dsh-changes-story

**What changed, in plain words.** After each completed agent turn, a separate window explains which files changed and why — short, beginner-friendly, no jargon. A **📖 Story** button also appears in the action strip (next to Copy / 👍 / 👎) under every turn that has a story, reopening that turn's explanation on demand.

[Русская версия ниже](#что-поменялось--простыми-словами)

## How it works

1. The built-in `workspace-changes` plugin records a `workspace/changes` event with the changed files at the end of every turn.
2. `dsh-changes-story` picks it up, collects the file list plus diff excerpts, and asks **the session's own model** for a compact story: a turn title, 1–2 plain sentences per file, one closing line. The answer is strictly JSON.
3. The web client polls the host every few seconds and opens the story window when a new story arrives. The **📖 Story** button in the turn's action strip reopens any earlier story (the host keeps the last 50 turns per session).

If the model is unavailable or answers non-JSON, the window still opens with bare facts (`file: +added / -deleted`).

## Installation

From the **Plugins** page or the CLI:

```cmd
dsh plugin --profile desktop add github:xzdes/dsh-changes-story
```

or a local checkout: `dsh plugin --profile desktop add link:C:\path\to\dsh-changes-story`
(run `pnpm install` in the checkout first — the only dependency is `@deepseek-ai/schemastery`).

Hot reload picks the plugin up; the window appears after the first turn that changes files.

## Settings

The window has an **"Open automatically"** checkbox — it writes the live volatile `autoOpen` config field, no restart. `enabled` / `autoOpen` / `language` are also editable from the plugin settings.

Static fields (via the profile's `cordis.patch.yml`, `config` line):

| Field | Default | Meaning |
|---|---|---|
| `language` | `ru` | Story language |
| `maxFiles` | `12` | Files explained per turn (the rest become a count) |
| `maxDiffChars` | `3000` | Diff characters per file sent to the model (0 = no diffs) |
| `maxOutputTokens` | `1500` | Story answer token cap |
| `timeoutMs` | `90000` | Per-generation deadline |
| `provider` + `model` | — | Explicit model route instead of the session's (only together) |

## Limitations

- Stories live in host memory and are forgotten on restart (like the change summaries themselves).
- Subagent sessions never record changes, so they produce no stories.
- Each turn with changes costs one extra short model call (up to 1500 tokens).

## Layout

```
lib/index.js   — host: session events, LLM call, GET /api/changes-story.{latest,get,turns}
lib/client.js  — browser: polling, story window (shell.overlay), Story button (assistant-actions)
cordis.patch.yml — inserts the plugin into the profile composition
locale/        — Plugins page display metadata
```

---

## Что поменялось — простыми словами

**Русская версия.** После каждого завершённого шага агента плагин открывает отдельное окно: какие файлы изменились и зачем — коротко и понятно, «как для новичка». А в ряду действий под каждым ответом (рядом с «Копировать» и 👍/👎) появляется кнопка **📖 Рассказ** — она заново открывает рассказ именно этого шага.

### Как это работает

1. Встроенный плагин `workspace-changes` в конце шага записывает событие со списком изменённых файлов.
2. `dsh-changes-story` ловит его, берёт список файлов и выдержки из диффов и просит **ту же модель, что вела сессию**, написать короткий рассказ: название шага, 1–2 предложения по каждому файлу и одно итоговое предложение.
3. Браузерная часть раз в несколько секунд спрашивает у хоста свежие рассказы: новый открывает окно сам, а кнопка **📖 Рассказ** открывает рассказ любого прошлого шага (хост хранит до 50 последних шагов сессии).

Если модель недоступна или ответила не JSON — показываются просто факты (`файл: +добавлено / -удалено`), окно всё равно откроется.

### Установка

Через страницу **Плагины** или CLI:

```cmd
dsh plugin --profile desktop add github:xzdes/dsh-changes-story
```

либо локальная копия: `dsh plugin --profile desktop add link:C:\путь\к\dsh-changes-story`
(перед этим один раз `pnpm install` в папке плагина — единственная зависимость: `@deepseek-ai/schemastery`).

### Настройки

В окне есть чекбокс **«Открывать автоматически»** — пишется в живую конфигурацию (`autoOpen`) без перезапуска. Поля `enabled` / `autoOpen` / `language` доступны и в настройках плагинов; статические поля — в таблице выше.

### Ограничения

- Рассказы живут в памяти хоста и пропадают при перезапуске (как и сами сводки изменений).
- Сессии субагентов не записывают изменения — рассказов по ним не бывает.
- На каждый шаг с изменениями — один дополнительный короткий вызов модели (до 1500 токенов).
