### Open Studio

1. Go to [studio.fablecut.space](https://studio.fablecut.space) in Chrome, Edge, Brave or Arc.
2. Click **New project** and pick where to save it, or **Open a folder** that already has your footage.
3. When the browser asks to let Studio read and save in that folder, choose **Allow on every visit**.

Studio opens the folder in the editor. Clips are read from the folder where they are, and the files are never uploaded. Your edits are saved to `project.json` in the same folder. Projects you have opened before are listed on the home page; opening one again only asks for the browser's permission.

Firefox and Safari can't open folders on your disk, so Studio needs a Chromium browser. On those browsers, run FableCut locally instead with `npx -y fablecut`.

### The project folder

A Studio project is a plain folder with the same layout as a local FableCut data folder:

| Path | What it holds |
|---|---|
| `project.json` | The timeline: canvas, tracks, clips, media list |
| `media/` | Clips you import from outside the folder |
| `exports/` | Your renders |

Clips already in the folder are used where they are, and new files you drop into it show up in the media bin. The same folder opens in the local editor too: `FABLECUT_DATA_DIR=<folder> npx -y fablecut`.

### Connect an agent

Open **Agent** in Studio's sidebar, or the **Agent** button in the editor. It shows your connection link and how to add it:

- **Claude Code:** `claude mcp add --transport http fablecut-studio <your link>`
- **claude.ai:** Settings, Connectors, **Add custom connector**, then paste the link.
- **ChatGPT and other MCP clients:** add a custom connector (a remote MCP server) with the same link.

The agent's tools run in your Studio tab, so keep it open while the agent works. Its edit commands, and any frames it asks to see, pass through Studio's relay (see below). If the agent calls while no project is open, Studio asks you to open one and the call carries on once you do. Every edit shows up live in the editor, and the Agent panel lists each call.

The link stays the same for every project in that browser. Anyone who has it can edit the project you have open, so keep it private. **New link** replaces it and cuts off every agent holding the old one; **Pause agent** stops calls until you resume.

### What passes through the server

The connection link points at a small relay on studio.fablecut.space. It forwards the agent's tool calls to your tab and the results back to the agent and doesn't store either. Your clip files never go through it. What does: the edit commands, the project text the agent reads, and the frames or scope readings the agent asks for with `fablecut_frame` and `fablecut_scopes`.

For usage numbers, the relay logs each call: which tool, whether it worked and how long it took, plus your country and a one-way hash of your IP address. It never logs the arguments, results, file names or frames.

### Exports

Studio renders in the browser and encodes H.264 video with AAC audio into an `.mp4`, saved to the project's `exports/` folder. Encoding profiles set the bitrate. Exports match the local editor's output frame for frame and in loudness.

### Studio or the local install

| | Studio | Local (`npx -y fablecut`) |
|---|---|---|
| Install | None | Node 18+, optional ffmpeg |
| Browser | Chrome, Edge, Brave, Arc | Any Chromium browser |
| Your media | Stays in the folder you pick | Stays in `~/FableCut` |
| Agents | Claude Code, claude.ai, ChatGPT and any MCP client, by link | Any MCP client on the same machine |
| Export | H.264 + AAC `.mp4`, in the browser | Adds ProRes and other ffmpeg profiles |
| Not in Studio yet | Import from a path or URL, reference analysis, noise reduction | |

### When Chrome pauses access

Chrome can pause a site's access to a folder when its tab sits in the background. Studio then shows **Resume access** at the top of the tab; click it and carry on. An agent's call waits for that click for about a minute and a half. Choosing **Allow on every visit** when Chrome first asks stops it happening.

### If something isn't working

If Studio won't load, or the agent panel says **Relay offline** for more than a minute, check [status.fablecut.space](https://status.fablecut.space). It checks the editor and the agent connection every 30 minutes and lists any recent outages.
