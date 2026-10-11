# Workbench for Arcade

A visual workbench for the [Arcade API](https://docs.arcade.ai). Every Arcade capability is a step you can drop on a canvas and wire to the next one. The canvas checks each step against Arcade's rules before anything runs, so you see what works and what doesn't without spending a generation. Any step can be forked into a variation, and every run is recorded.

Built at the Shopping 3.0 hackathon. No dependencies, no build step.

## Run it

Requires Node.js 22.5 or newer, for the SQLite driver built into Node. There is nothing to install.

```bash
cp .env.example .env      # then open .env and fill it in
node server.js
```

Open http://localhost:8787 and sign in with name `admin` and password `admin`. Change that with `WORKBENCH_USERS` in `.env` before anyone else can reach the server.

An Arcade key is optional in `.env`. With one, everyone who signs in can use it. Without one, each person adds their own under Models and keys. Create a key in [Arcade Studio](https://studio.arcade.ai/settings/api-keys) under Settings, API keys.

## What is in it

- **Bench.** The canvas. Steps are capabilities: pick a category, design from a prompt, refine, build a product, price it, make a checkout link, check an order. Wires carry results from one step to the next.
- **Checks before running.** A step Arcade would refuse is marked "Can't run" with the reason. Jewelry designs can't be refined, for example, and a jewelry category can't go to Build product.
- **Live status.** Each step shows running, worked with the time taken, or failed with Arcade's own message. Select a step to see every request and raw response.
- **Fork from anywhere.** Fork copies a step and everything after it, fed by the same steps as the original. Change the copy and run it to compare.
- **List in a store.** A step that adds a product to a WooCommerce or Shopify store at your own price, as a draft or live. Orders from the store are not sent to Arcade automatically.
- **Runs.** Success rate, counts of worked and failed runs, the same per step and per flow, typical times, and the reasons steps failed.
- **Keys on the page.** Two chips in the top bar show the Arcade key and the AI model. Click one for a small box: company key or your own, paste, Save and test. Claude, OpenAI and Gemini are fully set up, so a key is all anyone adds, and the box lists the text models that key can use.
- **Models and keys.** The full page: any number of AI models, including OpenRouter, Groq, Ollama, or anything OpenAI-compatible, with every setting open to change.
- **API watch.** A background check on the server. Every six hours it compares Arcade's published API, its documentation pages and each maker's model list with the last check and reports what changed.
- **Prompts.** A library of prompts that work, and prompt ideas from a connected model that follow Arcade's rules. Both are one click away on the Design step.
- **Data.** Flows, runs, prompts and connections are stored per account in one SQLite file. Download yours as JSON, or point the server at another file.
- **Docs.** The same guide, inside the app.

Start from a template in the flow menu. "What Arcade refuses, and why" shows the blocked cases.

## Keys and safety

- **Keys never reach the browser.** The page calls `/api/...` on the server, and the server adds the key.
- **Stored keys are encrypted.** They are sealed with `WORKBENCH_SECRET`, or with a random secret in `data/secret.key`. The page only ever sees the first and last characters.
- **Nothing secret is in the repo.** `.env` and `data/` are git-ignored. Never commit either.
- **The server listens on 127.0.0.1 only.** The sign-in is a light one: a name and a password, with no email, reset or second factor. Before exposing it, set `WORKBENCH_USERS` and `WORKBENCH_SECRET`, and put it behind HTTPS and your own access control.
- **Sharing host keys means sharing the bill.** Set `SHARE_HOST_KEYS=false` to make everyone bring their own.
- **Designs and products are real.** Steps marked as creating something add a design or product to the Arcade account in use.
- **Checkouts are real and always confirmed.** A checkout link is never part of Run flow. Nothing is charged until someone pays on Arcade's page. The workbench never pays.

## Settings

All in `.env`. See `.env.example` for the full list.

| Setting | What it does |
|---|---|
| `ARCADE_API_KEY` | Optional host key that signed-in people can use |
| `CONTACT_EMAIL` | Goes in the `User-Agent` Arcade requires |
| `WORKBENCH_USERS` | Accounts that always exist, as `name:password` pairs. The first is the admin |
| `ALLOW_SIGNUP` | Let people create accounts on the sign-in page |
| `SHARE_HOST_KEYS` | Let people use the keys in `.env` when they have none |
| `WORKBENCH_SECRET` | Encrypts stored API keys |
| `OPENAI_API_KEY` and friends | Optional host keys for AI models |
| `WATCH_HOURS` | How often the API watch runs. Defaults to 6; 0 turns it off |
| `DATABASE_PATH` | A SQLite file. Defaults to `data/workbench.db` |

## Add a capability

Each capability is one entry in `public/nodes.js`: its inputs, outputs, fields, the rules that decide whether it can run, and the calls it makes. Add an entry and it appears in the left panel. Add its endpoint to the allow-list in `server.js` if it is new.

## Limits

- **Runs live in the browser tab.** Close the tab mid-run and the canvas stops tracking the job. Arcade still finishes it, and the Saved design and Saved product steps bring it back.
- **SQLite only.** Postgres and hosted databases are not supported yet.
- **Not wired in:** upscale (Arcade Studio only, the public API returns 403), region edits (need a painted mask) and reference images.
- **AI models are used for prompt ideas only.** They are not steps on the bench yet.

## Files

- `server.js`: pages, sign-in, storage routes, and the allow-listed proxy to `https://platform.arcade.ai/v1`.
- `lib/store.js`: the SQLite store, accounts, sessions and key encryption.
- `lib/ai.js`: AI provider presets and the two wire formats.
- `lib/watch.js`: the API watch.
- `public/index.html`, `public/workbench.css`, `public/app.css`: the app shell and styles.
- `public/workbench.js`: the canvas, wiring, checks and runner.
- `public/nodes.js`: the capability catalogue and the templates.
- `public/app.js`: navigation and the Runs, Models and keys, Prompts, Data and Docs pages.
- `public/login.html`, `public/docs.html`: sign-in and the guide.
- `public/bench.html`: the plain test page, with every call and its raw response.

## License

MIT
