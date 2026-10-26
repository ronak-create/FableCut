### Open Studio

1. Go to [studio.fablecut.space](https://studio.fablecut.space) in Chrome, Edge, Brave or Arc. (In Firefox or Safari, see [Firefox and Safari](#firefox-and-safari) instead.)
2. Click **New project** and pick where to save it, or **Open a folder** that already has your footage.
3. When the browser asks to let Studio read and save in that folder, choose **Allow on every visit**.

Studio opens the folder in the editor. Clips are read from the folder where they are, and the files are never uploaded. Your edits are saved to `project.json` in the same folder. Projects you have opened before are listed on the home page; opening one again only asks for the browser's permission.

To try Studio without your own footage, click **Open the demo** on the home page: six skate clips, a music track and a first cut, kept in the browser's own storage (no folder to pick, nothing saved to your disk). It opens as you left it next time; exports from it download. Removing its card removes it, and the button brings a fresh copy back.

### Firefox and Safari

Firefox and Safari can't open folders on your disk, so there Studio keeps projects in the browser's own storage instead:

- **New project** starts an empty one; add clips with the editor's Import button or drop them onto the bin. They are copied into the browser's storage.
- **Import a folder** copies a folder of clips, or a FableCut project folder with its `project.json`, into a new project.
- Exports download to your computer instead of landing in `exports/`.
- **Download** on a project's card saves the whole project as a `.zip`: clips, `project.json` and versions. Unzip it and the folder opens in Studio on a Chromium browser, or locally with `FABLECUT_DATA_DIR=<folder> npx -y fablecut`.
- **Delete** (click twice) removes a project and its clips from the browser. The home page shows how much of the browser's storage the projects use.

The files are still never uploaded, and agents connect the same way. Browser storage holds a copy of each clip, and the browser may clear it when the disk runs low, so download projects you want to keep. Chrome, Edge, Brave and Arc open real folders and need none of this.

### The project folder

A Studio project is a plain folder with the same layout as a local FableCut data folder:

| Path | What it holds |
|---|---|
| `project.json` | The timeline: canvas, tracks, clips, media list |
| `media/` | Clips you import from outside the folder |
| `exports/` | Your renders |
| `history/` | Saved versions of the project |

Clips already in the folder are used where they are, and new files you drop into it show up in the media bin. The same folder opens in the local editor too: `FABLECUT_DATA_DIR=<folder> npx -y fablecut`.

### Connect an agent

The home page shows **Connect your agent** until one connects; it is also under **Agent** in Studio's sidebar and behind the **Agent** button in the editor. Pick your agent and **Copy setup** copies everything it needs, with your connection link in it:

- **Claude Code:** `claude mcp add --transport http fablecut-studio <your link>`
- **claude.ai:** Settings, Connectors, **Add custom connector**, then paste the link.
- **Cursor:** **Add to Cursor** adds it in one click, or paste the copied setup into `~/.cursor/mcp.json`.
- **opencode:** paste the copied setup into `opencode.json`.
- **ChatGPT and other MCP clients:** add a custom connector (a remote MCP server) with the same link.

Once an agent connects, Studio suggests a few things to ask it (make a reel, give it a look, tighten it, export it); **Copy** puts one on your clipboard to paste into the agent's chat.

The agent's tools run in your Studio tab, so keep it open while the agent works. Its edit commands, and any frames it asks to see, pass through Studio's relay (see below). If the agent calls while no project is open, Studio asks you to open one and the call carries on once you do. Every edit shows up live in the editor, and the Agent panel lists each call.

The link stays the same for every project in that browser. Anyone who has it can edit the project you have open, so keep it private. **New link** replaces it and cuts off every agent holding the old one; **Pause agent** stops calls until you resume.

### What passes through the server

The connection link points at a small relay on studio.fablecut.space. It forwards the agent's tool calls to your tab and the results back to the agent and doesn't store either. Your clip files never go through it. What does: the edit commands, the project text the agent reads, and the frames or scope readings the agent asks for with `fablecut_frame` and `fablecut_scopes`.

For usage numbers, the relay logs each call: which tool, whether it worked and how long it took, plus your country and a one-way hash of your IP address. The page also reports a few things you do in it, by name only: a project opened (a folder, browser storage or the demo), media imported, an export finished, an agent setup or a starter prompt copied, and, once per browser session, where the visit came from: a channel such as reddit, taken from a `?ref=` tag on the link or, without one, from the site that linked to Studio. It never logs the arguments, results, file or project names, or frames.

### Exports

Studio renders in the browser and encodes an `.mp4` with H.264 video and AAC audio (Opus in Firefox, which has no AAC encoder). In Chrome, Edge, Brave and Arc it is saved to the project's `exports/` folder; in Firefox and Safari it downloads. Encoding profiles set the bitrate. Delivery presets and batch outputs work too, with the browser's encoders: H.264, HEVC, VP9 and AV1 where the browser has them. ProRes, DNxHR, FFV1, PCM and 10-bit need ffmpeg, so Studio swaps in the closest browser format and says so. Exports match the local editor's output frame for frame and in loudness.

### Studio or the local install

| | Studio | Local (`npx -y fablecut`) |
|---|---|---|
| Install | None | Node 18+, optional ffmpeg |
| Browser | Chrome, Edge, Brave, Arc; Firefox and Safari keep projects in the browser | Any Chromium browser |
| Your media | Stays in the folder you pick (Firefox and Safari: copied into browser storage) | Stays in `~/FableCut` |
| Agents | Claude Code, claude.ai, Cursor, opencode, ChatGPT and any MCP client, by link | Any MCP client on the same machine |
| Export | `.mp4` in the browser (H.264, HEVC, VP9, AV1) | Adds ProRes, DNxHR, FFV1 and other ffmpeg profiles |
| Not in Studio yet | Import from a path or URL, reference analysis, noise reduction | |

### When Chrome pauses access

Chrome can pause a site's access to a folder when its tab sits in the background. Studio then shows **Resume access** at the top of the tab; click it and carry on. An agent's call waits for that click for about 40 seconds, then tells the agent to ask you for it. Choosing **Allow on every visit** when Chrome first asks stops it happening.

### If something isn't working

If Studio won't load, or the agent panel says **Relay offline** for more than a minute, check [status.fablecut.space](https://status.fablecut.space). It checks the editor and the agent connection every hour and lists any recent outages.

Something else wrong, or a question? Ask on the **[FableCut Discord](https://discord.gg/EFMQH7d6Tv)**, or email **[support@fablecut.space](mailto:support@fablecut.space)**. Say which browser and version you use, and what you did just before it went wrong.
