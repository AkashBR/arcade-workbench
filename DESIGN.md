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

The colours are Clay's own swatches, read from clay.com on 11 October 2026: oat for the neutrals and one fruit colour per job.

| Token | Hex | Clay swatch | Use |
|---|---|---|---|
| `--bench` | `#F9F8F6` | oat 100 | Page and canvas |
| `--paper` | `#FFFFFF` | white | Cards, panels, inputs |
| `--well` | `#FFFCFA` | oat 50 | Port strip, code blocks, disabled inputs |
| `--panel` | `#F3F2ED` | oat 200 | Soft fills, hovers |
| `--stone` | `#EEE9DF` | oat 300 | Neutral badges, pressed buttons |
| `--line` | `#E4DFD4` | between oat 300 and 400 | Hairlines and borders |
| `--ink` | `#1B1A18` | oat 950 | Text, primary button, selection |
| `--ink-2` | `#55534E` | oat 800 | Secondary text |
| `--ink-3` | `#77736C` | near oat 700 | Endpoints, placeholders |
| `--run` | `#2447D6` | blue | The one live colour: the mark for "working now". See the rule below |
| `--citron` | `#DDE6FC` | soft blue | The fill behind a live mark, and the ring on a focused input. The name is historical |

State colours: matcha `#02693E` on `#DBFFE0` for done, tangerine `#9F3E15` on `#FFE9D5` for "needs you", pomegranate `#B21A3F` on `#FFEBEC` for failed.

Kinds of step, shown as the colour of the step's line icon (no tile behind it): blueberry `#0667D9` for Start, dragonfruit `#CC0687` for Design, slushie `#0089AD` for Refine, lemon `#9D6A09` for Product, matcha `#078A52` for Sell, ube `#5C15CC` for model steps.

**The live-colour rule.** Blue means "this is working right now". It marks a running step, a wire carrying a call, a wire being pulled and the focused input. Nothing else is blue. It was yellow at first; yellow read as a warning, so it is not used for this.

The primary action is always ink. Corners follow Clay too: 8px on controls, 10px on cards, full pills only on status marks.

Do not use: gradients, shadows on cards, a fruit colour as a background fill, yellow for anything that is running, pure `#000000` text.

## Logos

Arcade and every model maker appear with their real mark wherever they are named: the header line, the key chips, the key box, the Models and keys page and the API watch. The files are in `public/logos/`, and `public/logos/MANIFEST.json` records where each came from. The marks are trademarks of their owners; they are shown here to name the service, which is fine for a demo, and should be checked against each brand's guidelines before a public launch.

## State: the visual cues

Every status uses one shape: a dot and a word on a tinted pill (`.stamp`). The step card and its wires repeat the same state.

| Status in code | Word shown | Pill | Dot | Card |
|---|---|---|---|---|
| `ready` | Ready | White, hairline | Hollow | Plain |
| `running` | Running 12s | Soft blue, blue text | Pulsing | Blue border, soft blue ring |
| `ok` | Worked · 3.0s | Green tint, `#1E6B45` | Filled | Plain |
| `stale` | Edited since run | Amber tint, `#7A4F00` | Hollow | Plain |
| `blocked` | Can't run | Amber tint | Filled | Dashed amber border |
| `waiting` | Waiting | Stone | Hollow | Dashed grey border |
| `error` | Failed · 412 | Red tint, `#A3281C` | Filled | Red border |

Wires follow the same logic:

- Light grey until the step before it has a result, then dark grey.
- Dashed amber when the step it feeds cannot run.
- Small blue marks moving along the wire while the step it feeds is running. No coloured band behind them.

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

- **Two bars:** a navigation row (wordmark, sections, who is signed in) and a flow row (flow name, flows menu, step counts, connection chip, More, Run flow). Both are white with a hairline.
- **The bench:** the canvas has the full width. The step list opens from "Add a step" on the left (248px). The side panel opens on the right (392px) when a step is selected or the step counts are clicked.
- **A blank bench** shows one start card: a serif question, four one-click workflows, and a text link to add steps by hand.
- **Step card:** 264px wide, white, hairline border, 12px corners. Order inside: icon, title and status, ports, a summary of what the step is set to, result preview, verdict, actions. Setup lives in the side panel, not on the card.
- **Side panel:** endpoint, serif title and status, one sentence, "Set it up", "Can it run?" with the actions, "Result", then two folded sections for Arcade's rules and the raw calls.
- **Other pages** (Runs, Models and keys, Prompts, Data, Docs): one column, 1120px at most, a serif page title, white cards on paper.
- **Canvas:** paper with a 24px dot grid.
- **Scale:** type 12 / 13 / 14 / 15 / 16, space 4 / 8 / 12 / 16 / 24 / 32 / 48, corners 8 for inputs and 12 for cards.

Three values are read by `workbench.js` and must not change in CSS: the 264px card width, the port dot's size and offset, and the 24px grid.

## Components

- **Primary button:** ink fill, white text, pill. One per context: Run flow in the bar, Run in the side panel, the confirming button in a dialog.
- **Secondary button:** white with a hairline, stone on hover.
- **Navigation tab:** secondary ink, turning ink with an ink underline for the current section.
- **Input:** white, hairline, 8px corners. On focus: ink border and a soft blue ring.
- **Picture tile:** a square picture or line icon over a label, three to a row. Chosen is an ink ring.
- **Chip:** a pill for one choice among several. Chosen is ink fill. What Arcade cannot make is struck through and cannot be pressed.
- **Port:** a dot on the card edge. Round carries a design, square a category, tombstone a product, diamond a checkout. Filled when wired.
- **Tag:** a small pill. Outlined for jewelry, stone for print, faint outline for read only.
- **Line icon:** 16px, 1.6 stroke, secondary ink. Always beside a label, never alone.
- **Number tile and table:** white, hairline, 12px corners. Numbers are tabular. A worked/failed bar always has its figures beside it.
- **Dialog and menu:** white, serif title on dialogs, actions right-aligned with the primary last. These two float above the page, so they are the only places a soft shadow is allowed.
- **Toast:** ink pill at the bottom centre.

## Motion

- Ease: `cubic-bezier(0.22, 1, 0.36, 1)`. Hovers and focus take 200ms.
- Only running things loop: the status dot pulses and the wire's dots move.
- `prefers-reduced-motion` turns it all off.

## Hard no

- Gradients, glows, card shadows.
- A second accent colour, or citron as decoration.
- Uppercase labels or monospace for anything that is not data.
- Cut or notched corners.
- A blocked step with no stated reason.
- An icon with no label beside it.

## Interface copy

Short sentences and plain verbs. A button says what it does. A status says what happened: "Worked · 3.0s". A blocked step says what to do: "Connect a design to this step."
