/* Agent-requested exports (POST /api/export/request, MCP fablecut_export).

   The compositor lives in the browser, so an export job is handed to an
   editor tab: an open one gets it over SSE, otherwise a headless Chrome /
   Edge is started on `/?exportJob=<id>` and closed when the job ends. The tab
   claims the job, renders it with the normal Fast export, and reports
   progress and the finished file back here. A job is
     pending → running → done | failed | cancelled
   and stays readable for an hour after it ends. Zero dependencies. */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const PENDING_TAB_MS = 20_000;       // an open tab answers SSE within a beat
const PENDING_HEADLESS_MS = 90_000;  // a cold browser has to boot and load media
const STALL_MS = 120_000;            // a running tab reports at least every few seconds
const KEEP_MS = 60 * 60 * 1000;

/** A Chromium-family browser to run headless: FABLECUT_CHROME, else the usual
 *  Chrome / Edge / Chromium install paths for this platform. Null if none. */
function findBrowser(env = process.env) {
  if (env.FABLECUT_CHROME) return fs.existsSync(env.FABLECUT_CHROME) ? env.FABLECUT_CHROME : null;
  const candidates = [];
  if (process.platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      candidates.push(path.join(r, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"));
      candidates.push(path.join(r, "Chromium", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
      const r = spawnSync("which", [name], { encoding: "utf8" });
      if (r.status === 0 && r.stdout.trim()) candidates.push(r.stdout.trim());
    }
  }
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/** opts: {url(id) → page to open headless, broadcast(event, data), editors() → open tab count} */
function createExportJobs(opts) {
  const jobs = new Map();
  let timer = null;
  const isEnded = (j) => j.status === "done" || j.status === "failed" || j.status === "cancelled";
  const view = (j) => ({
    id: j.id, kind: j.kind, status: j.status, via: j.via, range: j.range, profile: j.profile || null,
    time: j.time ?? null, progress: j.progress, src: j.src || null, result: j.result || null, error: j.error || null,
    created: j.created, updated: j.updated,
  });

  function closeBrowser(j) {
    const b = j.browser;
    if (!b) return;
    j.browser = null;
    try { b.proc.kill(); } catch {}
    // The profile dir is locked until the browser exits.
    const rm = (n) => fs.rm(b.profileDir, { recursive: true, force: true }, (err) => {
      if (err && n > 0) setTimeout(() => rm(n - 1), 1000);
    });
    b.proc.once("exit", () => rm(5));
    setTimeout(() => rm(5), 3000);
  }
  function end(j, status, fields = {}) {
    if (isEnded(j)) return;
    Object.assign(j, fields, { status, updated: Date.now() });
    closeBrowser(j);
  }
  function sweep() {
    const now = Date.now();
    for (const j of jobs.values()) {
      if (j.status === "pending" && now - j.created > (j.via === "headless" ? PENDING_HEADLESS_MS : PENDING_TAB_MS))
        end(j, "failed", { error: j.via === "headless"
          ? "the headless browser never picked up the job (it may have failed to start or to load the editor)"
          : "no editor tab picked up the job — is it busy exporting? Retry with where:\"headless\"" });
      else if (j.status === "running" && now - j.updated > STALL_MS)
        end(j, "failed", { error: "the editor stopped reporting progress (tab closed or browser crashed)" });
      else if (isEnded(j) && now - j.updated > KEEP_MS) jobs.delete(j.id);
    }
    if (![...jobs.values()].some((j) => !isEnded(j)) && timer) { clearInterval(timer); timer = null; }
  }
  function launch(j) {
    const exe = findBrowser();
    if (!exe) throw Object.assign(new Error("no editor tab is open and no Chrome / Edge was found to export headless — " +
      "open the editor in a browser, or set FABLECUT_CHROME to a Chromium-based browser"), { code: 409 });
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-export-"));
    const proc = spawn(exe, [
      "--headless=new", `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows", "--window-size=1600,900",
      opts.url(j.id),
    ], { stdio: "ignore", windowsHide: true });
    j.browser = { proc, profileDir };
    proc.on("error", (e) => end(j, "failed", { error: "could not start the headless browser: " + e.message }));
    proc.on("exit", () => { if (j.browser) { j.browser = null; if (!isEnded(j)) end(j, "failed", { error: "the headless browser exited before the export finished" }); } });
  }

  return {
    /** Queue an export. where: auto (open tab, else headless) · tab · headless.
     *  kind "scopes" measures one still at `time` instead (fablecut_scopes);
     *  kind "track" follows a region of a clip and saves it (fablecut_track). */
    request({ kind = "export", range, profile, time, revision, where = "auto", matte = null, mask = null, track = null }) {
      if (!["auto", "tab", "headless"].includes(where)) throw Object.assign(new Error("where must be auto, tab or headless"), { code: 400 });
      if (!["export", "scopes", "track"].includes(kind)) throw Object.assign(new Error("kind must be export, scopes or track"), { code: 400 });
      if (time != null && !(Number.isFinite(time) && time >= 0)) throw Object.assign(new Error("time must be seconds ≥ 0"), { code: 400 });
      if (range != null && range !== "entire" && range !== "in-out") throw Object.assign(new Error("range must be \"entire\" or \"in-out\""), { code: 400 });
      const busy = [...jobs.values()].find((j) => !isEnded(j));
      if (busy) throw Object.assign(new Error(`${busy.kind === "scopes" ? "scope reading" : busy.kind === "track" ? "tracking job" : "export"} ${busy.id} is still ${busy.status} — wait for it, or cancel it`), { code: 409 });
      const tabs = opts.editors();
      if (where === "tab" && !tabs) throw Object.assign(new Error("no editor tab is open — open the editor, or use where:\"headless\""), { code: 409 });
      const now = Date.now();
      const j = {
        id: "x_" + Math.random().toString(36).slice(2, 10), kind, status: "pending", progress: 0,
        range: range || null, profile: profile || null, time: time ?? null, revision: Number.isFinite(revision) ? revision : null,
        matte: kind === "scopes" && matte ? { clip: String(matte.clip), layer: matte.layer } : null,
        mask: kind === "scopes" && mask ? { clip: String(mask.clip) } : null,
        track: kind === "track" && track ? track : null,
        via: where === "headless" || (where === "auto" && !tabs) ? "headless" : "tab",
        created: now, updated: now,
      };
      if (j.via === "headless") launch(j);
      jobs.set(j.id, j);
      if (j.via === "tab") opts.broadcast("export", JSON.stringify(this.ticket(j.id)));
      if (!timer) { timer = setInterval(sweep, 1000); timer.unref?.(); }
      return view(j);
    },
    get(id) { const j = jobs.get(id); return j ? view(j) : null; },
    /** What a tab needs to run the job (headless pages fetch it by id). */
    ticket(id) { const j = jobs.get(id); return j ? { id: j.id, kind: j.kind, range: j.range, profile: j.profile, time: j.time, revision: j.revision, matte: j.matte || null, mask: j.mask || null, track: j.track || null, status: j.status } : null; },
    /** First tab to claim a pending job runs it. */
    claim(id) {
      const j = jobs.get(id);
      if (!j || j.status !== "pending") return false;
      j.status = "running"; j.updated = Date.now();
      return true;
    },
    /** Progress / result from the running tab. Returns {cancel} so a cancel reaches it. */
    report(id, { progress, status, src, result, error } = {}) {
      const j = jobs.get(id);
      if (!j) return null;
      if (j.status === "cancelled") return { cancel: true };
      if (j.status !== "running") return { cancel: false };
      j.updated = Date.now();
      if (Number.isFinite(progress)) j.progress = Math.max(0, Math.min(1, progress));
      if (status === "done") end(j, "done", { progress: 1, src: String(src || ""), result: result && typeof result === "object" ? result : null });
      else if (status === "failed") end(j, "failed", { error: String(error || "export failed") });
      return { cancel: false };
    },
    cancel(id) {
      const j = jobs.get(id);
      if (!j) return null;
      // A running tab hears about it on its next report and stops; pending just ends.
      if (!isEnded(j)) end(j, "cancelled", { error: "cancelled" });
      return view(j);
    },
    shutdown() { for (const j of jobs.values()) closeBrowser(j); if (timer) clearInterval(timer); },
  };
}

module.exports = { createExportJobs, findBrowser };
