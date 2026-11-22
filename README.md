# Storyviz
<img width="1350" height="707" alt="image" src="https://github.com/user-attachments/assets/c400cc8f-68c7-491f-96ea-400348a2c659" />

Write a story or a script on the left and each paragraph becomes an animated 3D scene on the right while you type. A coach reads the draft against published writing guides, fact-checks claims with web search, fills blanks, and can edit the draft when asked. Every change is kept in a version history, and any version can be restored or forked into a new project.

Built for the Cerebras x Kimi K3.1 Pro hackathon. The scenes are drawn by the model as a stream of small JSON lines (shapes, characters, motion, camera) that the page renders with three.js as they arrive, which is why a fast model matters.

## What is in here

- `app/server.mjs`: the whole server, plain Node with no framework. It serves the page, queues model requests, caches responses, saves projects and keeps their history in git.
- `app/public/`: the page. `main.js` is the editor, the agent panel and history; `scene.js` is the 3D renderer.
- `app/agents/`: the instructions for the two agents, `illustrator` (draws scenes) and `coach` (tips, fact checks, edits).
- `app/packs/`: one guide pack per kind of writing (children's story, short story, short video script, engineering docs). A pack holds the rules the coach checks against, with their sources, and a sample text.
- `app/prime.mjs`: warms the response cache with each pack's sample.
- `deploy.sh`: the script used to push to the author's own VM. Change the host and key before using it.

## Running it

You need Node 22 or newer, git, and an OpenClaw gateway on the same machine. All model calls go through the gateway's OpenAI-compatible chat completions endpoint.

1. Install the one dependency (three.js):

   ```
   npm install
   ```

2. In OpenClaw, turn on the gateway's chat completions endpoint and create two agents named `illustrator` and `coach`, each with a minimal tool profile and no skills. Copy `app/agents/illustrator.AGENTS.md` and `app/agents/coach.AGENTS.md` into their workspaces as `AGENTS.md`. The hackathon build used `moonshotai-kimi-k3.1-pro-trial` on Cerebras with low thinking; any fast model that follows the JSONL format should work.

3. Start the server:

   ```
   npm start
   ```

   and open http://127.0.0.1:8000.

Settings, all optional environment variables:

| Variable | Default | What it is |
| --- | --- | --- |
| `PORT` | `8000` | Port the app listens on |
| `OPENCLAW_GATEWAY` | `http://127.0.0.1:18789` | Gateway address |
| `OPENCLAW_GATEWAY_TOKEN` | read from `~/.openclaw/openclaw.json` | Gateway token |

Projects are saved as JSON in `data/projects/`, and `data/` is its own git repository that the server commits to as you work; that is the version history. Model responses are cached in `cache/`. Both folders are created on first run and are ignored by this repository.

Fact checks and research use Exa's public MCP search endpoint, so they need internet access.

There is no login. Anyone who can reach the port can read and change every project, so keep it on localhost or behind something that authenticates.

## License

MIT
