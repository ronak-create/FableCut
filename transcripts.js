/* Transcripts on disk, one per version of a file: analysis/transcripts/
   <stem>-<hash of its path>-<hash of its size and mtime>.json, holding the
   document transcribe.js validates ({v, src, model, language, duration,
   created, words:[[text, start, end], …]}, times in file seconds). A cache,
   like the proxies: a re-rendered or replaced file simply has no transcript
   until it is transcribed again, and saving a new one drops the old ones.

     createTranscripts({dir, resolveSrc}) → {
       get(src)        → the document | false (none for this version of the file) | null (no such file)
       info(src)       → {words, language, model, duration, created} | false | null — without the words
       put(src, doc)   → the document as saved (validated; throws on a bad one or a missing file)
       remove(src)     → true when one was deleted
     }
   Zero dependencies. */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const T = require("./transcribe.js");

const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);

function createTranscripts({ dir, resolveSrc }) {
  /** "<stem>-<path hash>-" (every version of the file) and the full name of this version. */
  function names(file) {
    const st = fs.statSync(file);
    const stem = path.basename(file, path.extname(file)).replace(/[^\w\-]+/g, "_").slice(0, 40) || "media";
    const prefix = `${stem}-${hash(path.resolve(file))}-`;
    return { prefix, name: `${prefix}${hash(st.size + "|" + Math.round(st.mtimeMs))}.json` };
  }
  function read(src) {
    const file = resolveSrc(src);
    if (!file) return null;
    let n;
    try { n = names(file); } catch { return null; }
    try { return JSON.parse(fs.readFileSync(path.join(dir, n.name), "utf8")); } catch { return false; }
  }
  return {
    get(src) {
      const d = read(src);
      if (!d) return d;
      try { return T.validate(d); } catch { return false; }
    },
    info(src) {
      const d = this.get(src);
      if (!d) return d;
      return { words: d.words.length, language: d.language, model: d.model, duration: d.duration, created: d.created };
    },
    put(src, doc) {
      const file = resolveSrc(src);
      if (!file) throw Object.assign(new Error("no such file: " + src), { code: 404 });
      const clean = T.validate({ ...doc, src });
      const { prefix, name } = names(file);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, name + ".tmp-" + process.pid);
      fs.writeFileSync(tmp, JSON.stringify(clean));
      fs.renameSync(tmp, path.join(dir, name));
      // earlier versions of the file keep nothing worth reading
      for (const old of fs.readdirSync(dir)) if (old !== name && old.startsWith(prefix) && old.endsWith(".json")) {
        try { fs.unlinkSync(path.join(dir, old)); } catch { }
      }
      return clean;
    },
    remove(src) {
      const file = resolveSrc(src);
      if (!file) return false;
      let prefix;
      try { prefix = names(file).prefix; } catch { return false; }
      let n = 0;
      let list = [];
      try { list = fs.readdirSync(dir); } catch { }
      for (const f of list) if (f.startsWith(prefix) && f.endsWith(".json")) { try { fs.unlinkSync(path.join(dir, f)); n++; } catch { } }
      return n > 0;
    },
  };
}

module.exports = { createTranscripts };
