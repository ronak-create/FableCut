/* FableCut saved workflows. Zero dependencies. Required by the server, the MCP
   server and the tests.

   A WORKFLOW is a recipe an agent can repeat on another project: a name, what
   it is for, and its steps in order. Each step is plain language ("Normalize the
   voice to -16 LUFS"), and may carry the tool call that did it last time:
     { id, name, description?, tags?, steps: [{ text, call?: { tool, args } }], created, updated }
   The agent reads the steps and does them again, using its own judgement where
   the footage differs (which clips, where the cuts go); a call is a worked
   example, not a script to replay blindly. Saved as library/workflows/<id>.json,
   shared by every project. */
"use strict";

const LIMITS = { name: 80, description: 600, step: 1000, steps: 50, tags: 12, tag: 32, args: 20000 };
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const clean = (s) => String(s == null ? "" : s).replace(/\r\n?/g, "\n").trim();

/** A checked copy of a workflow. strict: throw on anything wrong (saving);
 *  otherwise return null (reading files, where a bad one is skipped).
 *  tools: the tool names a call may use (default: any fablecut_ tool but this one). */
function normalizeWorkflow(w, strict, tools) {
  const bad = (msg) => { if (strict) throw new Error("workflow: " + msg); return null; };
  if (!w || typeof w !== "object" || Array.isArray(w)) return bad("expected an object {name, steps}");
  const name = clean(w.name);
  if (!name) return bad("name is required");
  if (name.length > LIMITS.name) return bad(`name is longer than ${LIMITS.name} characters`);
  const id = slug(w.id || name);
  if (!id) return bad("name needs a letter or digit");
  const description = clean(w.description);
  if (description.length > LIMITS.description) return bad(`description is longer than ${LIMITS.description} characters`);
  if (!Array.isArray(w.steps) || !w.steps.length) return bad("steps: at least one step");
  if (w.steps.length > LIMITS.steps) return bad(`at most ${LIMITS.steps} steps`);
  const steps = [];
  for (let i = 0; i < w.steps.length; i++) {
    const s = typeof w.steps[i] === "string" ? { text: w.steps[i] } : w.steps[i];
    const at = `step ${i + 1}`;
    if (!s || typeof s !== "object") return bad(`${at}: expected {text, call?}`);
    const text = clean(s.text);
    if (!text) return bad(`${at}: text is required (say what the step does)`);
    if (text.length > LIMITS.step) return bad(`${at}: text is longer than ${LIMITS.step} characters`);
    const step = { text };
    if (s.call != null) {
      const c = s.call;
      if (typeof c !== "object" || Array.isArray(c)) return bad(`${at}: call is {tool, args}`);
      const tool = String(c.tool || "");
      const allowed = tools ? tools.includes(tool) : /^fablecut_[a-z_]+$/.test(tool);
      if (!allowed || tool === "fablecut_workflows") return bad(`${at}: call.tool "${tool}" is not a FableCut tool${tools ? " (" + tools.join(", ") + ")" : ""}`);
      const args = c.args == null ? {} : c.args;
      if (typeof args !== "object" || Array.isArray(args)) return bad(`${at}: call.args is an object`);
      if (JSON.stringify(args).length > LIMITS.args) return bad(`${at}: call.args is larger than ${LIMITS.args} characters`);
      step.call = { tool, args: JSON.parse(JSON.stringify(args)) };
    }
    steps.push(step);
  }
  const out = { id, name };
  if (description) out.description = description;
  if (w.tags != null) {
    if (!Array.isArray(w.tags)) return bad("tags is a list of words");
    const tags = [...new Set(w.tags.map(clean).filter(Boolean))];
    if (tags.length > LIMITS.tags) return bad(`at most ${LIMITS.tags} tags`);
    if (tags.some((t) => t.length > LIMITS.tag)) return bad(`a tag is longer than ${LIMITS.tag} characters`);
    if (tags.length) out.tags = tags;
  }
  out.steps = steps;
  if (typeof w.created === "string") out.created = w.created;
  if (typeof w.updated === "string") out.updated = w.updated;
  return out;
}

/** Find a saved workflow by id or name (case-insensitive). */
function findWorkflow(list, key) {
  const k = String(key || "").trim().toLowerCase();
  if (!k) return null;
  return list.find((w) => w.id === k) || list.find((w) => w.name.toLowerCase() === k) || list.find((w) => w.id === slug(k)) || null;
}

/** One line per workflow, for listings. */
function workflowLine(w) {
  return `${w.id} — "${w.name}", ${w.steps.length} step${w.steps.length === 1 ? "" : "s"}` +
    (w.tags ? ` #${w.tags.join(" #")}` : "") + (w.description ? `: ${w.description.length > 140 ? w.description.slice(0, 140) + "…" : w.description}` : "");
}

/** The whole workflow as text an agent follows. */
function describeWorkflow(w) {
  const lines = [`Workflow "${w.name}" (${w.id})` + (w.tags ? ` #${w.tags.join(" #")}` : "")];
  if (w.description) lines.push(w.description);
  lines.push("");
  w.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.text}`);
    if (s.call) lines.push(`   last time: ${s.call.tool} ${JSON.stringify(s.call.args)}`);
  });
  return lines.join("\n");
}

module.exports = { LIMITS, slug, normalizeWorkflow, findWorkflow, workflowLine, describeWorkflow };
