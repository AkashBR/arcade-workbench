# Design guidelines: Workbench for Arcade

These rules govern every screen in the workbench. The tokens at the top of `public/workbench.css` implement them, and `public/app.css` reads the same tokens. Change a value here first, then in the code.

## Intent

The workbench lets someone wire Arcade's capabilities into a flow and see what Arcade will and will not allow. It should feel calm and exact. At any moment the reader can tell three things at a glance: what has worked, what is running, and what cannot run and why.

## Where the language comes from

Checked live on 11 October 2026.

| Reference | What we take |
|---|---|
| [arcade.ai](https://www.arcade.ai) | The colour family: warm paper, stone, near-black and citron. Instrument Sans for the interface, a Tiempos-style serif for titles. Pill buttons and 12px corners. |
| [vercel.com/geist](https://vercel.com/geist/introduction) | Status as a dot plus one word. Ink-black primary button. Even, tight spacing. |
| [mejuri.com](https://mejuri.com) | Product facts as a ruled list with small monospace for data. |

## Palette

Neutrals carry the page. Colour is kept for state.

| Token | Hex | Use |
|---|---|---|
| `--bench` | `#F7F4F0` | Page and canvas |
| `--paper` | `#FFFFFF` | Cards, panels, inputs |
| `--well` | `#FBFAF7` | Port strip, code blocks, disabled inputs |
| `--panel` | `#F3EFE8` | Soft fills |
| `--stone` | `#E9E5D8` | Neutral badges, hovers, image placeholders |
| `--line` | `#E2DDD0` | Hairlines and borders |
| `--ink` | `#0F0F0F` | Text, primary button, selection |
| `--ink-2` | `#55544C` | Secondary text |
| `--ink-3` | `#76746A` | Endpoints, placeholders, disabled marks |
| `--citron` | `#FCFF7B` | The one accent. See the rule below |

**The citron rule.** Citron means "this is happening right now". It marks a running step, a wire carrying a call, a wire being pulled and the focused input. Nothing else is citron.

`--wire` now resolves to `--ink`. There is no blue. The primary action is always ink.

Do not use: gradients, shadows on cards, a second accent, pure `#000000` text.

## State: the visual cues

Every status uses one shape: a dot and a word on a tinted pill (`.stamp`). The step card and its wires repeat the same state.

| Status in code | Word shown | Pill | Dot | Card |
|---|---|---|---|---|
| `ready` | Ready | White, hairline | Hollow | Plain |
| `running` | Running 12s | Citron | Pulsing | Ink border, citron ring |
| `ok` | Worked · 3.0s | Green tint, `#1E6B45` | Filled | Plain |
| `stale` | Edited since run | Amber tint, `#7A4F00` | Hollow | Plain |
| `blocked` | Can't run | Amber tint | Filled | Dashed amber border |
| `waiting` | Waiting | Stone | Hollow | Dashed grey border |
| `error` | Failed · 412 | Red tint, `#A3281C` | Filled | Red border |

Wires follow the same logic:

- Light grey until the step before it has a result, then dark grey.
- Dashed amber when the step it feeds cannot run.
- Ink dashes moving over a citron band while the step it feeds is running.

Rules that keep the cues honest:

- A state is never colour alone. It always has a word.
- A step that cannot run says why, in a sentence, on the card and in the details panel.
- Amber means the reader has something to fix. Grey dashed means it is only waiting on an earlier step.
- Capabilities Arcade does not offer sit under "Not on the bench" with a hollow dot and the reason.

## Typography

Three faces, each with one job.

- **Serif, Newsreader.** Weights 400 and 500. The wordmark, the details panel title, dialog titles and the empty state. Nowhere else.
- **Sans, Instrument Sans.** Weights 400, 500, 600. Everything else. It is Arcade's own interface face.
- **Mono, Geist Mono.** Weights 400 and 500. Data only: endpoints, IDs, status codes, raw calls, the zoom level.

| Role | Face | Size / line | Weight |
|---|---|---|---|
| Details and dialog title | Serif | 26 / 30 and 24 / 28 | 400 |
| Wordmark | Serif | 22 / 28 | 500 |
| Price in details | Sans | 22 / 26 | 600 |
| Price on a card | Sans | 18 / 24 | 600 |
| Step title | Sans | 15 / 20 | 600 |
| Body | Sans | 14 / 20 | 400 |
| Section heading in details | Sans | 13 / 18 | 600 |
| Field label, port, note | Sans | 12 to 13 / 16 to 18 | 400 to 500 |
| Status pill, tag | Sans | 11 to 11.5 / 16 to 18 | 500 |
| Endpoint, ID, raw call | Mono | 11 to 11.5 / 14 to 16 | 400 |

Labels are sentence case. Nothing is set in uppercase.

## Layout

- **Three columns:** capabilities (236px), canvas, details (352px). Below 1020px they stack.
- **Step card:** 264px wide, white, hairline border, 12px corners. Order inside: endpoint, title and status, ports, fields, result preview, verdict, actions.
- **Canvas:** paper with a 24px dot grid.
- **Spacing:** 4 / 8 / 12 / 16 / 24 / 32 / 48 only.

Three values are read by `workbench.js` and must not change in CSS: the 264px card width, the port dot's size and offset, and the 24px grid.

## Components

- **Primary button:** ink fill, white text, pill. One per context: Run flow in the bar, Run on a card, the confirming button in a dialog.
- **Secondary button:** white with a hairline in the bar, borderless on a card. Stone on hover.
- **Input:** white, hairline, 8px corners. On focus: ink border and a citron ring.
- **Port:** a dot on the card edge. Round carries a design, square a category, tombstone a product, diamond a checkout. Filled when wired.
- **Tag:** a small pill. Outlined for jewelry, stone for print, faint outline for read only.
- **Dialog:** white, 16px corners, serif title, actions right-aligned with the primary last.
- **Toast:** ink pill at the bottom centre.

## Motion

- Ease: `cubic-bezier(0.22, 1, 0.36, 1)`. Hovers and focus take 200ms.
- Only running things loop: the status dot pulses and the wire's dashes move.
- `prefers-reduced-motion` turns it all off.

## Hard no

- Gradients, glows, card shadows.
- A second accent colour, or citron as decoration.
- Uppercase labels or monospace for anything that is not data.
- Cut or notched corners.
- A blocked step with no stated reason.
- Icons without labels.

## Interface copy

Short sentences and plain verbs. A button says what it does. A status says what happened: "Worked · 3.0s". A blocked step says what to do: "Connect a design to this step."
