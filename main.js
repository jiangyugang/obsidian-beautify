/*
Beautify v2.0.0 — make Obsidian's file explorer work like Notion.

History: v1.x embedded the official builds of two MIT plugins — Explorer
Order Editor (vcarus) for saved manual order, and Branch Note (elfmedy) for
folder-as-page semantics — inside one bundle. v2.0.0 replaces BOTH embedded
cores with clean native rewrites (same behaviour, no Sortable.js, no order
note file, no settings-translation facade) and keeps the host layer: icons,
hide rules, quick access, per-folder sort modes, templates, child-page
blocks, task management and one combined settings tab.

Storage: ALL plugin state lives in the vault-level config note "Beautify.md"
(one ```json block, slots per concern), so it syncs with the vault across
devices instead of per-device data.json.

Credits: the two original plugins (both MIT) shaped the behaviour; their
authors did not participate in this rewrite. See LICENSE for the full texts.
*/

"use strict";
const obsidian = require("obsidian");
// v1.1.0: hiding the task date fields in live preview / source mode needs
// Obsidian's bundled @codemirror/view (the standard external plugins rely
// on). Where it is unavailable (plain node test runs, exotic hosts) editor
// hiding is skipped — reading view still hides, everything else works.
var CM6_VIEW = null;
try {
  CM6_VIEW = require("@codemirror/view");
} catch (e) {
  CM6_VIEW = null;
}

// ---------------------------------------------------------------------------
// §1 shared helpers
// ---------------------------------------------------------------------------
const parentOf = (path) => {
  const i = String(path).lastIndexOf("/");
  return i === -1 ? "" : String(path).slice(0, i);
};
const baseOf = (path) => {
  const i = String(path).lastIndexOf("/");
  return i === -1 ? String(path) : String(path).slice(i + 1);
};
const joinPath = (parent, name) => (parent && parent !== "/" ? `${parent}/${name}` : name);
const stemOf = (name) => String(name).replace(/\.md$/i, "");
const eqName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
// A Windows-safe file/folder name (also used when promoting notes to pages).
function validName(name) {
  return (
    !!name.trim() &&
    name === name.trim() &&
    !/[\\/:*?"<>|]/.test(name) &&
    !name.split("").some((c) => c.charCodeAt(0) < 32) &&
    !/[. ]$/.test(name) &&
    name !== "." &&
    name !== ".." &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  );
}
const folderKey = (folder) =>
  typeof folder.isRoot === "function" && folder.isRoot() ? "/" : folder.path;

// Deduplicate while preserving order.
function unique(names) {
  const seen = new Set();
  const out = [];
  for (const n of names) if (!seen.has(n)) (seen.add(n), out.push(n));
  return out;
}
// `saved` restricted to names present in `current` (in saved order), with any
// unsaved names appended in their incoming order. The heart of order render.
function mergedOrder(saved, current) {
  if (saved === undefined) return [...current];
  const have = new Set(current);
  const seen = new Set();
  const out = [];
  for (const n of saved) if (!seen.has(n) && have.has(n)) (seen.add(n), out.push(n));
  for (const n of current) if (!seen.has(n)) (seen.add(n), out.push(n));
  return out;
}

// ---------------------------------------------------------------------------
// §2 config note — the single source of truth (Beautify.md)
// ---------------------------------------------------------------------------
const CONFIG_NOTE = "Beautify.md";
const LEGACY_CONFIG_NOTES = ["Notionify.md"];
// Plugin ids whose data.json is imported once on first run.
const LEGACY_PLUGIN_IDS = ["branch-note", "explorer-order-editor", "branch-order", "iconic", "hide-folders"];

// [diag] runtime forensics for the v2.10.x boot/unload anomalies.
// TEMPORARILY OFF (2.10.12) — flip __BDIAG_ON to true to re-enable; the
// call sites stay so nothing else changes. "/tmp/…" does not exist for the
// Obsidian process on Windows (writes threw and were swallowed — the log
// never landed); TEMP first, /tmp fallback.
const __BDIAG_ON = false;
let __bdiagPath = null;
function __bdiag(msg) {
  if (!__BDIAG_ON) return;
  try {
    const fs = require("fs");
    const path = require("path");
    if (__bdiagPath === null) {
      const base =
        (typeof process !== "undefined" && process.env && process.env.TEMP) || "/tmp";
      __bdiagPath = path.join(base, "beautify-diag.log");
    }
    fs.appendFileSync(__bdiagPath, new Date().toISOString() + " " + msg + "\n");
  } catch (e) {}
}

// Serialize one debounced disk flush of the config note onto its write queue.
// Shared by writeSlot's timer and flush(); dirty stays set on failure so the
// next flush retries.
function enqueueConfigFlush(cfg) {
  cfg.writeQueue = cfg.writeQueue
    .then(async () => {
      if (!cfg.dirty) return;
      cfg.dirty = false;
      try {
        await cfg.write();
      } catch (e) {
        cfg.dirty = true;
        throw e;
      }
    })
    .catch((e) => console.error("[beautify] failed to persist plugin data:", e));
  return cfg.writeQueue;
}

class ConfigNote {
  constructor(plugin) {
    this.plugin = plugin;
    this.data = {};
    this.writeQueue = Promise.resolve();
    // v2.10.4 ①: slots mutated since the last successful disk write (external
    // changes are adopted at slot granularity — see __adoptExternalConfig),
    // and the exact note text we last persisted (to ignore our own echoes in
    // the vault "modify" handler).
    this.dirtySlots = new Set();
    this.lastWritten = null;
  }
  async load() {
    const raw = await this.#readNote(CONFIG_NOTE);
    if (raw != null) {
      const parsed = parseJsonBlock(raw);
      if (parsed && typeof parsed === "object") {
        this.data = parsed;
        return;
      }
    }
    // Upgrade: re-materialise a config note left under a previous plugin name.
    for (const legacy of LEGACY_CONFIG_NOTES) {
      const legacyRaw = await this.#readNote(legacy);
      if (legacyRaw == null) continue;
      const legacyParsed = parseJsonBlock(legacyRaw);
      if (legacyParsed && typeof legacyParsed === "object") {
        this.data = legacyParsed;
        console.log("[beautify] imported config from legacy note " + legacy);
        await this.write();
        return;
      }
    }
    // First run: data.json → legacy chain, then materialise the note.
    let data = null;
    try {
      data = await this.plugin.loadData();
    } catch (e) {
      console.error("[beautify] failed to read plugin data:", e);
    }
    if (!(data && typeof data === "object" && Array.isArray(data.migratedFrom))) {
      const prior = await this.plugin.readLegacyData("branch-order");
      if (prior && typeof prior === "object" && prior.branchNote !== undefined) {
        data = prior;
        if (!Array.isArray(data.migratedFrom)) data.migratedFrom = ["branch-order"];
        console.log("[beautify] imported settings from the previous Branch & Order plugin");
      } else {
        data = {
          migratedFrom: LEGACY_PLUGIN_IDS.slice(0, 2),
          branchNote: (await this.plugin.readLegacyData("branch-note")) || {},
          orderEditor: (await this.plugin.readLegacyData("explorer-order-editor")) || {},
        };
        console.log("[beautify] finished first-run migration (Branch Note + Explorer Order Editor data imported)");
      }
    }
    this.data = data || {};
    await this.write();
  }
  async #readNote(path) {
    try {
      const file = this.plugin.app.vault.getFileByPath(path);
      if (file instanceof obsidian.TFile) return await this.plugin.app.vault.cachedRead(file);
      const adapter = this.plugin.app.vault.adapter;
      if (adapter && typeof adapter.exists === "function" && (await adapter.exists(path)))
        return await adapter.read(path);
    } catch (e) {
      console.error("[beautify] failed to read the config note:", e);
    }
    return null;
  }
  async write() {
    const __start = Date.now();
    let __t = Date.now();
    const body = JSON.stringify(this.data, null, 2);
    const __strMs = Date.now() - __t;
    const vault = this.plugin.app.vault;
    try {
      let file = vault.getFileByPath(CONFIG_NOTE);
      if (!(file instanceof obsidian.TFile)) {
        // Cold start: the vault may not have indexed the note yet, so a plain
        // create() would hit "File already exists". Only create when the file
        // truly does not exist; otherwise wait for the index to catch up.
        const adapter = vault.adapter;
        const exists =
          adapter && typeof adapter.exists === "function"
            ? await adapter.exists(CONFIG_NOTE)
            : false;
        if (!exists) {
          const text =
            "本笔记由 Beautify 插件维护,存储插件配置;下方 json 块为机器生成,可随库在多设备间同步。\n\n```json\n" +
            body +
            "\n```\n";
          await vault.create(CONFIG_NOTE, text);
          this.lastWritten = text;
          this.dirtySlots.clear();
          return;
        }
        file = await this.#awaitIndexed();
      }
      if (file instanceof obsidian.TFile) {
        __t = Date.now();
        const raw = await vault.read(file);
        const __readMs = Date.now() - __t;
        __t = Date.now();
        const next = replaceJsonBlock(raw, body);
        const __splMs = Date.now() - __t;
        __t = Date.now();
        await vault.modify(file, next);
        this.lastWritten = next;
        this.dirtySlots.clear();
        const __modMs = Date.now() - __t;
        const __all = Date.now() - __start;
        if (this.plugin.__traceMark) {
          this.plugin.__traceMark("config.write总计", __all);
          this.plugin.__traceMark("config.stringify", __strMs);
          this.plugin.__traceMark("config.read", __readMs);
          this.plugin.__traceMark("config.splice(块替换)", __splMs);
          this.plugin.__traceMark("config.modify(写盘)", __modMs);
        }
        if (__all > 80)
          console.warn(
            "[beautify] slow config write: " +
              __all +
              "ms (stringify " +
              __strMs +
              " / read " +
              __readMs +
              " / splice " +
              __splMs +
              " / modify " +
              __modMs +
              ", " +
              Math.round(body.length / 1024) +
              "KB)"
          );
      } else {
        // Last resort: the vault never indexed the note (a very cold start on
        // a big vault). Write through the adapter so a real settings change
        // can't be silently dropped; the next indexed read picks it up.
        const adapter = vault.adapter;
        if (adapter && typeof adapter.write === "function") {
          const raw =
            typeof adapter.read === "function" ? await adapter.read(CONFIG_NOTE) : "";
          const next = replaceJsonBlock(raw, body);
          await adapter.write(CONFIG_NOTE, next);
          this.lastWritten = next;
          this.dirtySlots.clear();
        } else {
          console.error("[beautify] the config note exists but was never indexed; write skipped");
        }
      }
    } catch (e) {
      console.error("[beautify] failed to write the config note:", e);
      // Re-throw so enqueueConfigFlush can keep `dirty` set and retry (the
      // documented v2.7.3 intent — write() swallowing the error here used to
      // clear the flag even when nothing reached disk).
      throw e;
    }
  }
  #awaitIndexed(retries = 30) {
    const vault = this.plugin.app.vault;
    return new Promise((resolve) => {
      const poll = (left) => {
        const file = vault.getFileByPath(CONFIG_NOTE);
        if (file instanceof obsidian.TFile || left <= 0) return resolve(file ?? null);
        setTimeout(() => poll(left - 1), 100);
      };
      poll(retries);
    });
  }
  // Slots — one named object per concern; writes are serialised.
  async readSlot(key) {
    const slot = this.data && typeof this.data === "object" ? this.data[key] : undefined;
    return slot && typeof slot === "object" ? slot : {};
  }
  writeSlot(key, value) {
    // Memory updates synchronously (readSlot always returns fresh data); the
    // disk write is debounced so bursts collapse into ONE full-file write —
    // a 666-child folder rename used to enqueue one write per rename event
    // (v2.7.3; measured: 3 choked writes, one blocking vault.modify 25s).
    if (!this.data || typeof this.data !== "object") this.data = {};
    this.data[key] = value;
    if (!this.dirtySlots) this.dirtySlots = new Set();
    this.dirtySlots.add(key);
    this.dirty = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      enqueueConfigFlush(this);
    }, 200);
    return this.writeQueue;
  }
  async flush() {
    // Force any pending debounced write out now (quit / unload paths).
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      enqueueConfigFlush(this);
    }
    await this.writeQueue;
  }
}

// Parse the first ```json fenced block of a note into an object (or null).
function parseJsonBlock(raw) {
  try {
    const lines = String(raw).split("\n");
    const open = lines.findIndex((l) => l.trimEnd() === "```json");
    if (open === -1) return null;
    const close = lines.findIndex((l, i) => i > open && l.trimEnd() === "```");
    if (close === -1) return null;
    return JSON.parse(lines.slice(open + 1, close).join("\n"));
  } catch (e) {
    console.error("[beautify] the config note's json block could not be parsed:", e);
    return null;
  }
}
// Replace the json block's body, keeping any surrounding prose untouched.
function replaceJsonBlock(raw, body) {
  const lines = String(raw).split("\n");
  const open = lines.findIndex((l) => l.trimEnd() === "```json");
  const fenced = open === -1 ? ["```json", ...body.split("\n"), "```"] : body.split("\n");
  if (open === -1) return String(raw).replace(/\s*$/, "") + "\n\n" + fenced.join("\n") + "\n";
  const close = lines.findIndex((l, i) => i > open && l.trimEnd() === "```");
  if (close === -1) return raw; // unterminated — leave untouched
  return [...lines.slice(0, open + 1), ...fenced, ...lines.slice(close)].join("\n");
}

// ---------------------------------------------------------------------------
// §3 OrderCore — native rewrite of the embedded Explorer Order Editor
// ---------------------------------------------------------------------------
// Same behaviour as the vendored original, minus what the config note made
// obsolete: no order-note file, no quarantine/repair machinery (corrupt data
// is simply re-imported from the note's last good state on sync), no
// Sortable.js (native drag), and settings live in the host tab natively.
//
// The saved order is a Map<folderKey, string[]> of child NAMES, "/" = root.
class OrderStore {
  constructor(plugin) {
    this.plugin = plugin;
    this.index = new Map();
    this.settings = { dragToReorder: true, showMoveActions: false };
    this.usable = true;
    this.timer = null;
    this.chain = Promise.resolve();
    this.dirty = false;
  }
  get(key) {
    return this.index.get(key);
  }
  keys() {
    return new Set(this.index.keys());
  }
  isUsable() {
    return this.usable;
  }
  // Apply fn(map) → map (or the same map for "no change"); schedules a save.
  update(fn) {
    try {
      const next = fn(this.index);
      if (next !== this.index) {
        this.index = next;
        this.#scheduleSave();
      }
      return true;
    } catch (e) {
      console.error("[beautify] failed to update the saved order:", e);
      return false;
    }
  }
  #scheduleSave() {
    this.dirty = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#enqueueSave();
    }, 200);
  }
  #enqueueSave() {
    this.chain = this.chain.then(() => this.#persist()).catch((e) => {
      console.error("[beautify] failed to save the order index:", e);
    });
    return this.chain;
  }
  async #persist() {
    if (!this.dirty) return;
    this.dirty = false;
    const __t = Date.now();
    try {
      await this.plugin.config.writeSlot("orderEditor", {
        dragToReorder: this.settings.dragToReorder,
        showMoveActions: this.settings.showMoveActions,
        // v1.3.0: the document TREE (order + icons in one nested structure);
        // icons are read LIVE from the host settings — the tree is their only
        // serialized home now
        index: bnTreeFromMaps(this.index, this.plugin.settings && this.plugin.settings.icons),
      });
    } finally {
      if (this.plugin.__traceMark) this.plugin.__traceMark("order.persist(writeSlot)", Date.now() - __t);
    }
  }
  async flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.#enqueueSave();
    }
    await this.chain;
    // writeSlot is debounced as of v2.7.3 — force the config note to disk on
    // quit/unload, or a pending 200ms timer would be killed with the window.
    await this.plugin.config.flush();
  }
  async setSettings(patch) {
    Object.assign(this.settings, patch);
    this.dirty = true;
    await this.#enqueueSave();
  }
  // ---- load & migration ----------------------------------------------------
  async load() {
    const slot = await this.plugin.config.readSlot("orderEditor");
    this.settings.dragToReorder = slot.dragToReorder !== false;
    this.settings.showMoveActions = slot.showMoveActions === true;
    let index = null;
    let migrated = false;
    // v3 = the nameless root node {order?, children}; v2 = flat {path: [names]}.
    // Discrimination: v3 carries children as an array of single-key node
    // objects / an `order: true` flag; a v2 folder literally named "children"
    // ({"children": ["a.md"]}) holds STRING names and must stay v2.
    const idxVal = slot.index;
    const isV3 =
      idxVal &&
      typeof idxVal === "object" &&
      !Array.isArray(idxVal) &&
      (Array.isArray(idxVal.children) ||
        idxVal.order === true ||
        Object.keys(idxVal).length === 0) &&
      !(Array.isArray(idxVal.children) && idxVal.children.some((x) => typeof x === "string"));
    if (isV3) {
      // v1.3.0 steady shape: the document tree (order + icons). The tree is
      // the ONLY serialized home of icons, so it REPLACES the in-memory map —
      // merge semantics would un-delete icons removed on another device (an
      // external clear-all must propagate). Legacy flat host-slot icons only
      // exist alongside a v2 slot and are migrated into the tree on its
      // first v3 save.
      const parsed = bnMapsFromTree(idxVal);
      index = parsed.index;
      this.plugin.settings.icons = parsed.icons;
      // re-baseline saveSettings' changed-detection — the replaced map came
      // from the note itself, no reserialization is pending
      this.plugin.__iconsJson = JSON.stringify(parsed.icons);
    }
    if (!index && idxVal && typeof idxVal === "object" && !Array.isArray(idxVal)) {
      index = indexFromPlain(idxVal); // v2 flat map → rewrite as a tree
      migrated = true;
    }
    if (!index && typeof slot.indexBackup === "string" && slot.indexBackup !== "") {
      // v1.x kept the whole order-note TEXT in indexBackup.
      const parsed = parseJsonBlock(slot.indexBackup);
      if (parsed && typeof parsed === "object") index = indexFromPlain(parsed);
      migrated = true;
    }
    if (!index) {
      // Pre-1.9.0 leftovers: a physical order note next to the config note.
      index = await this.#importLegacyNoteFile(slot.indexPath);
      if (index) migrated = true;
    }
    this.index = index || new Map();
    this.usable = true;
    // v2 → v3 rewrite pending: the host learns via this flag (its save then
    // strips the now-redundant flat icons so the note converts fully once).
    this.migratedToTree = migrated;
    // Only a real migration (or a first-ever save) rewrites the slot; a
    // steady-state load must not touch the config note at all.
    if (migrated) {
      this.dirty = true;
      await this.#enqueueSave();
    }
  }
  // Icons changed through the host settings path (picker, auto-icon, rename
  // rekey) — the tree is their only serialized home, so reserialize it.
  touchIcons() {
    this.dirty = true;
    void this.#enqueueSave();
  }
  async #importLegacyNoteFile(indexPath) {
    try {
      const path = (0, obsidian.normalizePath)(String(indexPath || "explorer-order.md"));
      if (path === CONFIG_NOTE || LEGACY_CONFIG_NOTES.includes(path)) return null;
      const file = this.plugin.app.vault.getFileByPath(path);
      if (!(file instanceof obsidian.TFile)) return null;
      const parsed = parseJsonBlock(await this.plugin.app.vault.read(file));
      if (!parsed || typeof parsed !== "object") return null;
      const index = indexFromPlain(parsed);
      await this.plugin.app.fileManager.trashFile(file);
      new obsidian.Notice(
        this.plugin.isZh()
          ? "Beautify:排序数据已迁入 Beautify.md,旧的排序笔记已移入回收站。"
          : "Beautify: saved orders moved into Beautify.md; the old order note went to the trash.",
        6000
      );
      return index;
    } catch (e) {
      console.error("[beautify] failed to import the legacy order note:", e);
      return null;
    }
  }
}
function indexFromPlain(obj) {
  const map = new Map();
  for (const [key, value] of Object.entries(obj || {})) {
    if (typeof key !== "string" || !Array.isArray(value)) continue;
    const names = value.filter((n) => typeof n === "string");
    if (names.length) map.set(key, names);
  }
  return map;
}
function indexToPlain(map) {
  const out = {};
  for (const [key, names] of map) out[key] = names;
  return out;
}
// ---- v1.3.0: orderEditor slot v3 — the document TREE format --------------------
// The old `index` was a flat {folderPath: [names]} map — readable, but the
// hierarchy had to be re-derived from path strings, and item ICONS lived in a
// separate flat path→emoji map in the host slot (2000+ entries). v3 stores one
// nested tree mirroring the vault:
//   "index": { "order": true, "children": [
//     { "工作空间": { "icon": "🏢", "order": true, "children": [
//         { "待办事项": { "icon": "✅", "order": true, "children": [
//             { "转发配置表迁移.md": { "icon": "😣" } },
//             { "待办事项.md": {} }
//         ]}}
//     ]}}
//   ]}
// The `index` value is the nameless ROOT node; below it each item is
// { [name]: { icon?, order?, children? } }.
//   • children ARRAY ORDER is a saved manual order IFF the node has
//     "order": true — pass-through folders (nodes that exist only to host a
//     deep icon) must NOT freeze their children's sort.
//   • The root's own saved order is the root node's order flag (the old "/"
//     key of the flat map).
// Runtime stays FLAT (store.index Map + settings.icons object) — the tree is
// purely the serialization; every consumer keeps its existing model.

// flat maps → tree array (deterministic: pass-through children name-sorted,
// ordered folders list children in saved order with icon-only extras appended
// name-sorted — exactly where mergedOrder would have put them anyway).
function bnTreeFromMaps(indexMap, icons) {
  const root = { name: "", icon: "", order: null, children: new Map() };
  const nodeAt = (parent, name) => {
    let n = parent.children.get(name);
    if (!n) {
      n = { name: name, icon: "", order: null, children: new Map() };
      parent.children.set(name, n);
    }
    return n;
  };
  for (const [path, icon] of Object.entries(icons || {})) {
    if (typeof icon !== "string" || icon === "") continue;
    const parts = String(path).split("/");
    if (!parts.length || parts.some((p) => !p)) continue;
    let n = root;
    for (const p of parts) n = nodeAt(n, p);
    n.icon = icon;
  }
  for (const [key, names] of indexMap || []) {
    if (!Array.isArray(names) || !names.length) continue;
    const parts = key === "/" ? [] : String(key).split("/");
    if (parts.some((p) => !p)) continue;
    let n = root;
    for (const p of parts) n = nodeAt(n, p);
    n.order = names.filter((x) => typeof x === "string" && x !== "");
    for (const nm of n.order) nodeAt(n, nm); // keep icon-less/deleted names round-tripping
  }
  const build = (node) => {
    const kids = Array.from(node.children.values());
    if (!kids.length) return [];
    let seq = kids;
    if (node.order) {
      const inOrder = new Set(node.order);
      const rest = kids.filter((k) => !inOrder.has(k.name));
      rest.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      seq = node.order
        .map((nm) => node.children.get(nm))
        .filter(Boolean)
        .concat(rest);
    } else {
      kids.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    const out = [];
    for (const k of seq) {
      const attrs = {};
      if (k.icon) attrs.icon = k.icon;
      if (k.order) attrs.order = true;
      const sub = build(k);
      if (sub.length) attrs.children = sub;
      const wrap = {};
      wrap[k.name] = attrs;
      out.push(wrap);
    }
    return out;
  };
  // The slot's `index` is the ROOT NODE object (nameless): {order?, children}
  // — the root's own saved order needs a flag carrier just like any folder.
  const rootAttrs = {};
  if (root.order) rootAttrs.order = true;
  const kids = build(root);
  if (kids.length) rootAttrs.children = kids;
  return rootAttrs;
}
// Root node object (or, tolerantly, a bare children array — a hand-simplified
// note) → flat maps. Tolerant of hand edits: single-key nodes expected, first
// key wins; non-object attrs ignored; empty order arrays mean "no saved
// order" (same as the old indexFromPlain semantics).
function bnMapsFromTree(rootNode) {
  const index = new Map();
  const icons = {};
  const nameOf = (wrap) =>
    wrap && typeof wrap === "object" && !Array.isArray(wrap) ? Object.keys(wrap)[0] : null;
  const readOrder = (attrs, key) => {
    if (attrs.order === true && Array.isArray(attrs.children)) {
      const names = attrs.children
        .map(nameOf)
        .filter((n) => typeof n === "string" && n !== "");
      if (names.length) index.set(key, names);
    }
  };
  const walk = (arr, path) => {
    if (!Array.isArray(arr)) return;
    for (const wrap of arr) {
      const name = nameOf(wrap);
      if (typeof name !== "string" || name === "") continue;
      const attrs = wrap[name];
      if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) continue;
      const childPath = path === "" ? name : path + "/" + name;
      if (typeof attrs.icon === "string" && attrs.icon !== "") icons[childPath] = attrs.icon;
      readOrder(attrs, childPath);
      walk(attrs.children, childPath);
    }
  };
  if (rootNode && typeof rootNode === "object" && !Array.isArray(rootNode)) {
    // the root's own order lives on the nameless root node ("/" key)
    readOrder(rootNode, "/");
    walk(rootNode.children, "");
  } else if (Array.isArray(rootNode)) {
    // tolerated simplified shape: a bare children array (root unordered)
    walk(rootNode, "");
  }
  return { index: index, icons: icons };
}
// ---- index maintenance (pure; each returns a NEW map or the same one) ------
// Folder renamed: rename its key and every descendant key.
function indexAfterFolderRename(map, from, to) {
  if (from === to) return map;
  const prefix = from + "/";
  const remap = (k) => (k === from ? to : k.startsWith(prefix) ? to + k.slice(from.length) : null);
  const touched = new Set();
  for (const k of map.keys()) {
    const r = remap(k);
    if (r !== null) touched.add(k);
  }
  if (!touched.size) return map;
  const next = new Map();
  for (const [k, names] of map) {
    const r = remap(k);
    if (r !== null) next.set(r, names);
    else if (!touched.has(k)) next.set(k, names);
  }
  return next;
}
// Item renamed within its folder: swap the old name for the new one, keeping
// the position. `stillInside` false (moved away) → drop the name instead.
function indexAfterItemRename(map, folderKeyOfParent, oldName, newName, stillInside) {
  const saved = map.get(folderKeyOfParent);
  if (saved === undefined || !saved.includes(oldName)) return map;
  const names = stillInside
    ? saved.map((n) => (n === oldName ? newName : n))
    : saved.filter((n) => n !== oldName);
  const next = new Map(map);
  if (names.length) next.set(folderKeyOfParent, unique(names));
  else next.delete(folderKeyOfParent);
  return next;
}
function indexAfterItemRemoved(map, folderKeyOfParent, name) {
  const saved = map.get(folderKeyOfParent);
  if (saved === undefined || !saved.includes(name)) return map;
  const names = saved.filter((n) => n !== name);
  const next = new Map(map);
  if (names.length) next.set(folderKeyOfParent, names);
  else next.delete(folderKeyOfParent);
  return next;
}
function indexAfterFolderDeleted(map, folderKeyOfDeleted) {
  if (!map.has(folderKeyOfDeleted)) return map;
  const next = new Map(map);
  next.delete(folderKeyOfDeleted);
  return next;
}
// Move `name` inside `names` — "up" | "down" | "top" | "bottom"; null = no-op.
function movedNames(names, name, dir) {
  const from = names.indexOf(name);
  if (from === -1) return null;
  let to = null;
  if (dir === "up" && from > 0) to = from - 1;
  else if (dir === "down" && from < names.length - 1) to = from + 1;
  else if (dir === "top" && from !== 0) to = 0;
  else if (dir === "bottom" && from !== names.length - 1) to = names.length - 1;
  if (to === null) return null;
  const out = [...names];
  out.splice(from, 1);
  out.splice(to, 0, name);
  return out;
}
// Drop `dragged` next to `anchor` inside `names`; null = no-op.
function insertedNames(names, dragged, anchor, side) {
  if (dragged === anchor) return null;
  const rest = names.filter((n) => n !== dragged);
  const at = rest.indexOf(anchor);
  if (at === -1) return null;
  rest.splice(side === "before" ? at : at + 1, 0, dragged);
  if (rest.length === names.length && rest.every((n, i) => n === names[i])) return null;
  return rest;
}

// ---- explorer integration --------------------------------------------------
class OrderCore {
  constructor(plugin) {
    this.plugin = plugin;
    this.store = new OrderStore(plugin);
    this.unloaders = [];
    this.dragViews = new Map(); // containerEl → detach fn
    this.sortPatched = false;
    this.chain = Promise.resolve();
  }
  zh() {
    return this.plugin.isZh();
  }
  async activate() {
    await this.store.load();
    __bdiag("OrderCore.activate: store keys=" + this.store.keys().size + " usable=" + this.store.usable); // [diag]
    this.#patchSortWithRetry();
    this.#registerIndexSync();
    this.#registerDragSync();
    this.unloaders.push(() => {
      for (const detach of this.dragViews.values()) detach();
      this.dragViews.clear();
    });
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("quit", (cancel) => cancel.add(() => this.store.flush()))
    );
    this.plugin.register(() => void this.store.flush());
  }
  // Patch FileExplorer.prototype.getSortedFolderItems once a view exists
  // (retrying on layout-change, matching the original's cold-start care).
  #patchSortWithRetry() {
    const tryPatch = () => {
      if (this.sortPatched) return true;
      const view = explorerViews(this.plugin.app)[0];
      if (!view) {
        __bdiag("tryPatch: no explorer view yet"); // [diag]
        return false;
      }
      const proto = Object.getPrototypeOf(view);
      // [diag] log the chain + which level owns the method
      try {
        let chain = [],
          p = proto;
        for (let d = 0; d < 5 && p && p !== Object.prototype; d++) {
          chain.push(
            (p.constructor && p.constructor.name ? p.constructor.name : "?") +
              (Object.hasOwn(p, "getSortedFolderItems") ? "*own*" : "")
          );
          p = Object.getPrototypeOf(p);
        }
        __bdiag("tryPatch: chain=" + chain.join(" < "));
      } catch (e) {}
      if (!Object.hasOwn(proto, "getSortedFolderItems")) return true;
      const previous = proto.getSortedFolderItems;
      const core = this;
      const wrapper = function (folder) {
        return core.applySavedOrder(folder, previous.call(this, folder));
      };
      proto.getSortedFolderItems = wrapper;
      this.sortPatched = true;
      this.unloaders.push(() => {
        // restore the ORIGINAL own property (it existed — we only patch when
        // Object.hasOwn was true), never delete it: the explorer's own code
        // calls this method after the plugin is disabled.
        if (proto.getSortedFolderItems === wrapper) proto.getSortedFolderItems = previous;
      });
      for (const v of explorerViews(this.plugin.app)) v.requestSort?.();
      return true;
    };
    if (tryPatch()) return;
    const off = this.plugin.app.workspace.on("layout-change", () => {
      if (tryPatch()) this.plugin.app.workspace.offref(off);
    });
    this.plugin.registerEvent(off);
  }
  // Saved order first, unsaved items after, in the incoming order.
  applySavedOrder(folder, items) {
    try {
      if (!items || !items.length) return items;
      const saved = this.store.get(folderKey(folder));
      const plugin = this.plugin;
      const byName = new Map();
      const current = [];
      for (const item of items) {
        const file = item?.file;
        if (!(file instanceof obsidian.TFile) && !(file instanceof obsidian.TFolder)) return items;
        if (plugin.isSystemNote(file.path)) continue; // the config note never shows
        byName.set(file.name, item);
        current.push(file.name);
      }
      const out = [];
      for (const name of mergedOrder(saved, current)) {
        const item = byName.get(name);
        if (item !== undefined) out.push(item);
      }
      return out;
    } catch (e) {
      console.error("[beautify] failed to render the saved order:", e);
      return items;
    }
  }
  refresh() {
    let ok = false;
    for (const view of explorerViews(this.plugin.app)) {
      try {
        view.requestSort();
        ok = true;
      } catch (e) {
        /* view gone */
      }
    }
    return ok;
  }
  // The folder's order as currently SHOWN (saved order + live explorer sort),
  // read straight off a live view — the same source the original used.
  currentNames(folder) {
    const view = explorerViews(this.plugin.app).find((v) => typeof v.getSortedFolderItems === "function");
    try {
      if (!view) return null;
      const items = view.getSortedFolderItems(folder) || [];
      const names = [];
      for (const item of items) {
        const file = item?.file;
        if (!(file instanceof obsidian.TFile) && !(file instanceof obsidian.TFolder)) return null;
        if (this.plugin.isSystemNote(file.path)) continue;
        names.push(file.name);
      }
      return names;
    } catch (e) {
      console.error("[beautify] failed to read the current explorer order:", e);
      return null;
    }
  }
  // ---- keep the index in step with renames/deletes -------------------------
  #registerIndexSync() {
    const plugin = this.plugin;
    const store = this.store;
    const refresh = () => this.refresh();
    const enqueue = (label, fn) => {
      this.chain = this.chain.then(fn).catch((e) => {
        console.error("[beautify] failed to update the saved order after " + label + ":", e);
      });
    };
    this.plugin.registerEvent(
      plugin.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof obsidian.TFile) && !(file instanceof obsidian.TFolder)) return;
        if (plugin.__traceOpen) plugin.__traceOpen("rename: " + oldPath + " → " + (file.path || "?"));
        if (file instanceof obsidian.TFolder) {
          const from = oldPath,
            to = file.path;
          enqueue("a rename", () => {
            const __t = Date.now();
            try {
              store.update((m) => indexAfterFolderRename(m, from, to));
            } finally {
              if (plugin.__traceMark) plugin.__traceMark("order.folderRename(索引重键)", Date.now() - __t);
            }
            const __t2 = Date.now();
            refresh();
            if (plugin.__traceMark) plugin.__traceMark("order.refresh(requestSort)", Date.now() - __t2);
          });
        }
        const oldParent = parentOf(oldPath);
        const parentFolder =
          oldParent === ""
            ? plugin.app.vault.getRoot()
            : plugin.app.vault.getFolderByPath?.(oldParent) || null;
        if (!parentFolder) return;
        const key = folderKey(parentFolder);
        const inSameFolder = file.parent?.path === parentFolder.path;
        const oldName = baseOf(oldPath);
        enqueue("a rename", () => {
          store.update((m) => indexAfterItemRename(m, key, oldName, file.name, inSameFolder));
          refresh();
        });
      })
    );
    this.plugin.registerEvent(
      plugin.app.vault.on("delete", (file) => {
        if (!(file instanceof obsidian.TFile) && !(file instanceof obsidian.TFolder)) return;
        const parentPath = parentOf(file.path);
        const parentFolder =
          parentPath === ""
            ? plugin.app.vault.getRoot()
            : plugin.app.vault.getFolderByPath?.(parentPath) || null;
        if (parentFolder) {
          const key = folderKey(parentFolder);
          enqueue("a delete", () => {
            store.update((m) => indexAfterItemRemoved(m, key, file.name));
            refresh();
          });
        }
        if (file instanceof obsidian.TFolder) {
          const key = file.path;
          enqueue("a delete", () => {
            store.update((m) => indexAfterFolderDeleted(m, key));
            refresh();
          });
        }
      })
    );
  }
  // ---- drag to reorder inside the explorer ---------------------------------
  #registerDragSync() {
    const resync = () => {
      const seen = new Set();
      for (const view of explorerViews(this.plugin.app)) {
        const el = view.containerEl;
        if (!el) continue;
        seen.add(el);
        if (!this.dragViews.has(el)) this.dragViews.set(el, attachDragHandlers(this, el));
      }
      for (const [el, detach] of this.dragViews) {
        if (!seen.has(el)) {
          detach();
          this.dragViews.delete(el);
        }
      }
    };
    resync();
    this.plugin.registerEvent(this.plugin.app.workspace.on("layout-change", resync));
  }
  async applyDrop(dragged, anchor, side) {
    const parent = anchor.parent;
    if (!parent) return;
    const movingIn = dragged.parent?.path !== parent.path;
    const names =
      this.currentNames(parent) ||
      [...parent.children].filter((c) => !this.plugin.isSystemNote(c.path)).map((c) => c.name);
    const next = insertedNames(names, dragged.name, anchor.name, side);
    if (next === null) return;
    if (movingIn) {
      const dest = (0, obsidian.normalizePath)(
        parent.isRoot?.() ? dragged.name : `${parent.path}/${dragged.name}`
      );
      try {
        await this.plugin.app.fileManager.renameFile(dragged, dest);
      } catch (e) {
        new obsidian.Notice(
          this.zh()
            ? `无法把 ${dragged.name} 移入 ${parent.isRoot?.() ? "库根目录" : parent.name}:${e instanceof Error ? e.message : String(e)}`
            : `Could not move ${dragged.name} into ${parent.name}: ${e instanceof Error ? e.message : String(e)}`
        );
        return;
      }
    }
    const key = folderKey(parent);
    if (this.store.update((m) => new Map(m).set(key, next))) this.refresh();
  }
  // ---- move commands (up/down/top/bottom) ----------------------------------
  canMove(file, dir) {
    if (!(file instanceof obsidian.TFile) && !(file instanceof obsidian.TFolder)) return false;
    const parent = file.parent;
    if (!parent) return false;
    const names = this.currentNames(parent);
    if (!names) return false;
    return movedNames(names, file.name, dir) !== null;
  }
  async move(file, dir) {
    const parent = file.parent;
    if (!parent) return;
    const names = this.currentNames(parent);
    if (!names) return;
    const next = movedNames(names, file.name, dir);
    if (next === null) return;
    if (this.store.update((m) => new Map(m).set(folderKey(parent), next))) this.refresh();
  }
  // The file "under the cursor": the explorer's focused item if the explorer
  // is active, else the active markdown file.
  fileUnderCursor() {
    const focusedView = explorerViews(this.plugin.app).find((v) => v.tree && typeof v.tree === "object");
    const focused = focusedView?.tree?.focusedItem?.file;
    if (focused instanceof obsidian.TFile || focused instanceof obsidian.TFolder) return focused;
    return this.plugin.app.workspace.getActiveFile();
  }
  // ---- per-folder actions used by menus, commands and the modal ------------
  saveFolderOrder(folder, names) {
    const ok = this.store.update((m) => {
      const next = new Map(m);
      if (names.length) next.set(folderKey(folder), names);
      else next.delete(folderKey(folder));
      return next;
    });
    if (ok) this.refresh();
    return ok;
  }
  clearFolderOrder(folder) {
    if (this.store.update((m) => indexAfterFolderDeleted(m, folderKey(folder)))) this.refresh();
  }
  removeStaleOrders() {
    const vault = this.plugin.app.vault;
    let removed = 0;
    this.store.update((m) => {
      const next = new Map(m);
      for (const key of [...next.keys()]) {
        if (key === "/") continue;
        if (!(vault.getFolderByPath?.(key) instanceof obsidian.TFolder)) {
          next.delete(key);
          removed++;
        }
      }
      return next;
    });
    return removed;
  }
  openModal(folder) {
    new OrderModal(this.plugin.app, this, folder).open();
  }
  unload() {
    for (const fn of this.unloaders) {
      try {
        fn();
      } catch (e) {
        /* already gone */
      }
    }
    this.unloaders = [];
  }
}
function explorerViews(app) {
  const out = [];
  try {
    for (const leaf of app.workspace.getLeavesOfType("file-explorer")) {
      const view = leaf.view;
      if (view?.containerEl && view.fileItems && typeof view.getSortedFolderItems === "function")
        out.push(view);
    }
  } catch (e) {
    /* workspace gone */
  }
  return out;
}
// Capture-phase drag handlers on one explorer container. The drop indicator
// uses the same eoe-drop-before/after classes the original CSS styled.
function attachDragHandlers(core, containerEl) {
  let indicator = null; // { el, side }
  const clearIndicator = () => {
    if (indicator) indicator.el.classList.remove("eoe-drop-before", "eoe-drop-after");
    indicator = null;
  };
  const resolve = (event) => {
    if (!core.store.settings.dragToReorder) return null;
    try {
      const draggable = core.plugin.app.dragManager?.draggable;
      if (draggable == null || (draggable.type !== "file" && draggable.type !== "folder"))
        return null;
      const dragged = draggable.file;
      if (!(dragged instanceof obsidian.TFile) && !(dragged instanceof obsidian.TFolder))
        return null;
      if (!(event.target instanceof Element)) return null;
      const rowEl = event.target.closest(".nav-file-title, .nav-folder-title");
      if (!(rowEl instanceof HTMLElement)) return null;
      const path = rowEl.getAttribute("data-path");
      if (!path) return null;
      const anchor = core.plugin.app.vault.getAbstractFileByPath(path);
      if (!(anchor instanceof obsidian.TFile) && !(anchor instanceof obsidian.TFolder)) return null;
      if (anchor.path === dragged.path) return null;
      const anchorParent = anchor.parent;
      if (!anchorParent) return null;
      if (
        dragged instanceof obsidian.TFolder &&
        (anchorParent.path === dragged.path || anchorParent.path.startsWith(dragged.path + "/"))
      )
        return null;
      // Side zones: files split 50/50; folders keep their middle free so the
      // native drop-INTO-folder behaviour stays reachable.
      const rect = rowEl.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)));
      let side = null;
      if (anchor instanceof obsidian.TFile) side = ratio < 0.5 ? "before" : "after";
      else if (rowEl.parentElement?.classList.contains("is-collapsed") === true)
        side = ratio < 0.25 ? "before" : ratio >= 0.75 ? "after" : null;
      else side = ratio < 0.25 ? "before" : null;
      if (side === null) return null;
      return { dragged, anchor, rowEl, side };
    } catch (e) {
      console.error("[beautify] failed to resolve a drag target:", e);
      return null;
    }
  };
  const onOver = (event) => {
    const target = resolve(event);
    if (!target) {
      clearIndicator();
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (indicator && indicator.el === target.rowEl && indicator.side === target.side) return;
    clearIndicator();
    indicator = { el: target.rowEl, side: target.side };
    target.rowEl.classList.add(target.side === "before" ? "eoe-drop-before" : "eoe-drop-after");
    const manager = core.plugin.app.dragManager;
    if (typeof manager?.updateHover === "function") manager.updateHover(null, "");
  };
  const onDrop = (event) => {
    const target = resolve(event);
    clearIndicator();
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    void core.applyDrop(target.dragged, target.anchor, target.side);
  };
  const onLeave = (event) => {
    if (event.relatedTarget instanceof Node && containerEl.contains(event.relatedTarget)) return;
    clearIndicator();
  };
  const onEnd = () => clearIndicator();
  containerEl.addEventListener("dragover", onOver, true);
  containerEl.addEventListener("drop", onDrop, true);
  containerEl.addEventListener("dragleave", onLeave, true);
  containerEl.addEventListener("dragend", onEnd, true);
  return () => {
    clearIndicator();
    containerEl.removeEventListener("dragover", onOver, true);
    containerEl.removeEventListener("drop", onDrop, true);
    containerEl.removeEventListener("dragleave", onLeave, true);
    containerEl.removeEventListener("dragend", onEnd, true);
  };
}

// ---- the "Set explorer order" modal (native, no Sortable.js) ---------------
// Rows reorder via native HTML5 drag (grab anywhere, the grip is the afford-
// ance), alt+arrow keys, or the per-row top/bottom buttons. The eoe-* classes
// are the ones the original modal's CSS already styles.
class OrderModal extends obsidian.Modal {
  constructor(app, core, folder) {
    super(app);
    this.core = core;
    this.plugin = core.plugin;
    this.folder = folder;
    this.listEl = null;
    this.entryByRow = new Map();
    this.initialNames = [];
    this.sortMode = "current"; // "current" | "name" | "mtime"
    this.busy = false;
    this.closed = false;
  }
  zh() {
    return this.plugin.isZh();
  }
  onOpen() {
    this.modalEl.addClass("eoe-modal");
    this.render();
  }
  onClose() {
    this.closed = true;
    this.contentEl.empty();
  }
  // Entries: the folder's children minus system notes, in the order the
  // explorer currently shows, already merged with the saved order.
  collectEntries() {
    const plugin = this.plugin;
    const entries = [];
    for (const child of this.folder.children) {
      if (!(child instanceof obsidian.TFile) && !(child instanceof obsidian.TFolder)) continue;
      if (plugin.isSystemNote(child.path)) continue;
      entries.push({
        name: child.name,
        kind: child instanceof obsidian.TFolder ? "folder" : "file",
        ctime: child instanceof obsidian.TFile ? child.stat?.ctime ?? null : null,
        mtime: child instanceof obsidian.TFile ? child.stat?.mtime ?? null : null,
        folder: child instanceof obsidian.TFolder ? child : null,
      });
    }
    return entries;
  }
  orderedEntries() {
    const entries = this.collectEntries();
    const byName = new Map(entries.map((e) => [e.name, e]));
    const current =
      this.core.currentNames(this.folder) ?? entries.map((e) => e.name);
    const saved = this.core.store.get(folderKey(this.folder));
    const names =
      this.sortMode === "name"
        ? [...entries].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((e) => e.name)
        : this.sortMode === "mtime"
          ? [...entries].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)).map((e) => e.name)
          : mergedOrder(saved, current);
    const out = [];
    for (const name of names) {
      const e = byName.get(name);
      if (e !== undefined) out.push(e);
    }
    return out;
  }
  render() {
    const zh = this.zh();
    this.setTitle(zh ? "设置文件列表排序" : "Set explorer order");
    this.entryByRow.clear();
    this.renderBreadcrumbs();
    const entries = this.orderedEntries();
    if (entries.length === 0) {
      this.contentEl.createDiv({ cls: "eoe-empty", text: zh ? "这个目录没有可排序的条目。" : "This folder has nothing to order." });
      this.renderFooter(false);
      return;
    }
    if (entries.length === 1) {
      const list = this.contentEl.createDiv({ cls: "eoe-static-list" });
      this.renderRow(list, entries[0], false);
      this.contentEl.createDiv({
        cls: "eoe-hint",
        text: zh ? "只有一个条目,无需排序。" : "Only one item here, so there is nothing to reorder.",
      });
      this.renderFooter(false);
      return;
    }
    const list = this.contentEl.createDiv({ cls: "eoe-list" });
    this.listEl = list;
    for (const entry of entries) this.renderRow(list, entry, true);
    this.contentEl.createDiv({
      cls: "eoe-hint",
      text: zh
        ? "拖动行调整顺序;也可以点选一行后按 Alt+↑/↓ 移动,Alt+Shift+↑/↓ 置顶/置底。"
        : "Drag rows to reorder; or click a row and press Alt+↑/↓ to move it, Alt+Shift+↑/↓ for top/bottom.",
    });
    this.initialNames = this.currentNames();
    this.refreshActionStates();
    this.renderFooter(true);
  }
  renderBreadcrumbs() {
    const zh = this.zh();
    const el = this.contentEl.createDiv({ cls: "eoe-breadcrumb" });
    const chain = [];
    for (let f = this.folder; f !== null; f = f.parent) chain.unshift(f);
    const vaultName = this.app.vault.getName?.() || "Vault";
    chain.forEach((folder, i) => {
      const row = el.createDiv({ cls: `eoe-breadcrumb-row eoe-breadcrumb-depth-${Math.min(i, 4)}` });
      if (i > 0) row.createSpan({ cls: "eoe-breadcrumb-tee", text: "└", attr: { "aria-hidden": "true" } });
      const label =
        typeof folder.isRoot === "function" && folder.isRoot()
          ? vaultName
          : folder.name;
      if (i === chain.length - 1) {
        row.createSpan({ cls: "eoe-breadcrumb-current", text: label });
        // sort-by control sits on the current crumb's row
        const sortBtn = row.createEl("button", { cls: "eoe-sort-by-button" });
        const sortLabel =
          this.sortMode === "name"
            ? zh ? "按名称" : "Sorted by name"
            : this.sortMode === "mtime"
              ? zh ? "按修改时间" : "Sorted by modified"
              : zh ? "排序方式" : "Sort by";
        sortBtn.setText(sortLabel);
        const menu = new obsidian.Menu();
        const setMode = (mode) => {
          this.sortMode = mode;
          this.resetAndRender();
        };
        menu.addItem((item) =>
          item.setTitle(zh ? "当前顺序" : "Current order").onClick(() => setMode("current"))
        );
        menu.addItem((item) => item.setTitle(zh ? "名称" : "Name").onClick(() => setMode("name")));
        menu.addItem((item) =>
          item.setTitle(zh ? "修改时间" : "Modified time").onClick(() => setMode("mtime"))
        );
        sortBtn.addEventListener("click", (ev) => menu.showAtMouseEvent(ev));
      } else {
        const crumb = row.createEl("button", { cls: "eoe-breadcrumb-crumb", attr: { type: "button" } });
        crumb.createSpan({ cls: "eoe-breadcrumb-label", text: label });
        crumb.addEventListener("click", () => void this.navigateTo(folder));
      }
    });
    return el;
  }
  renderRow(list, entry, interactive) {
    const zh = this.zh();
    const row = list.createDiv({ cls: "eoe-row" });
    this.entryByRow.set(row, entry);
    if (!interactive) {
      this.renderRowInner(row, entry, false);
      return;
    }
    row.setAttribute("tabindex", "0");
    row.draggable = true;
    row.addEventListener("dragstart", (ev) => {
      this.dragRow = row;
      row.addClass("eoe-row-chosen");
      try {
        ev.dataTransfer?.setData("text/plain", entry.name);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      } catch (e) {
        /* decorative payload */
      }
    });
    row.addEventListener("dragend", () => {
      row.removeClass("eoe-row-chosen");
      this.clearDropMarks();
      this.dragRow = null;
    });
    row.addEventListener("dragover", (ev) => {
      if (!this.dragRow || this.dragRow === row) return;
      ev.preventDefault();
      const side = this.dropSide(row, ev);
      this.markDrop(row, side);
    });
    row.addEventListener("drop", (ev) => {
      if (!this.dragRow || this.dragRow === row) return;
      ev.preventDefault();
      const side = this.dropSide(row, ev);
      this.clearDropMarks();
      const dragged = this.dragRow;
      this.dragRow = null;
      this.insertRow(dragged, row, side);
    });
    row.addEventListener("keydown", (ev) => this.onRowKeyDown(ev, row));
    this.renderRowInner(row, entry, true);
  }
  renderRowInner(row, entry, interactive) {
    const zh = this.zh();
    const handle = row.createSpan({ cls: "eoe-row-handle", attr: { "aria-hidden": "true" } });
    try {
      (0, obsidian.setIcon)(handle, "grip-vertical");
    } catch (e) {
      /* decorative */
    }
    const icon = row.createSpan({ cls: "eoe-row-icon" });
    try {
      (0, obsidian.setIcon)(icon, entry.kind === "folder" ? "folder" : "file-text");
    } catch (e) {
      /* decorative */
    }
    const text = row.createSpan({ cls: "eoe-row-text" });
    text.createSpan({
      cls: "eoe-row-name",
      text: entry.kind === "file" ? stemOf(entry.name) || entry.name : entry.name,
    });
    if (this.sortMode === "mtime" && entry.mtime) {
      const d = new Date(entry.mtime);
      const pad = (n) => String(n).padStart(2, "0");
      text.createSpan({
        cls: "eoe-row-date",
        text: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      });
    }
    if (!interactive) return;
    const actions = row.createSpan({ cls: "eoe-row-actions" });
    const mkBtn = (icon, label, onClick) => {
      const btn = actions.createEl("button", {
        cls: "clickable-icon eoe-row-action",
        attr: { "aria-label": label, type: "button" },
      });
      try {
        (0, obsidian.setIcon)(btn, icon);
      } catch (e) {
        /* decorative */
      }
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onClick();
      });
      return btn;
    };
    const top = mkBtn("chevrons-up", zh ? "移到顶部" : "Move to top", () => this.moveRow(row, "top"));
    const bottom = mkBtn("chevrons-down", zh ? "移到底部" : "Move to bottom", () => this.moveRow(row, "bottom"));
    row.__bnTop = top;
    row.__bnBottom = bottom;
    if (entry.folder) {
      const enter = mkBtn("circle-chevron-right", zh ? "进入子目录" : "Enter subfolder", () =>
        void this.navigateTo(entry.folder)
      );
      enter.addClass("eoe-row-enter");
    }
  }
  dropSide(row, ev) {
    const rect = row.getBoundingClientRect();
    return ev.clientY < rect.top + rect.height / 2 ? "before" : "after";
  }
  markDrop(row, side) {
    if (row.__bnDropSide === side) return;
    this.clearDropMarks();
    row.__bnDropSide = side;
    row.addClass(side === "before" ? "eoe-drop-before" : "eoe-drop-after");
  }
  clearDropMarks() {
    for (const row of this.listEl?.children ?? []) {
      if (!(row instanceof HTMLElement)) continue;
      if (row.__bnDropSide) {
        row.removeClass("eoe-drop-before", "eoe-drop-after");
        row.__bnDropSide = null;
      }
    }
  }
  insertRow(dragged, anchor, side) {
    if (!this.listEl || dragged === anchor) return;
    dragged.remove();
    const ref =
      side === "before" ? anchor : anchor.nextElementSibling ?? null;
    this.listEl.insertBefore(dragged, ref);
    dragged.focus();
    this.refreshActionStates();
  }
  onRowKeyDown(ev, row) {
    if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
    ev.preventDefault();
    const up = ev.key === "ArrowUp";
    if (ev.altKey && ev.shiftKey) this.moveRow(row, up ? "top" : "bottom");
    else if (ev.altKey) this.moveRow(row, up ? "up" : "down");
    else this.focusRow(this.rows().indexOf(row) + (up ? -1 : 1));
  }
  rows() {
    if (!this.listEl) return [];
    return [...this.listEl.children].filter((c) => c instanceof HTMLElement && this.entryByRow.has(c));
  }
  focusRow(index) {
    const rows = this.rows();
    if (index >= 0 && index < rows.length) rows[index].focus();
  }
  moveRow(row, dir) {
    if (!this.listEl) return;
    const rows = this.rows();
    const from = rows.indexOf(row);
    const to =
      dir === "up" ? from - 1 : dir === "down" ? from + 1 : dir === "top" ? 0 : rows.length - 1;
    if (from === -1 || to < 0 || to >= rows.length || to === from) return;
    row.remove();
    if (dir === "bottom") this.listEl.appendChild(row);
    else this.listEl.insertBefore(row, this.listEl.children[to] ?? null);
    row.focus();
    row.scrollIntoView({ block: "nearest" });
    this.refreshActionStates();
  }
  refreshActionStates() {
    const rows = this.rows();
    rows.forEach((row, i) => {
      if (row.__bnTop) row.__bnTop.disabled = i === 0;
      if (row.__bnBottom) row.__bnBottom.disabled = i === rows.length - 1;
    });
  }
  currentNames() {
    return this.rows().map((row) => this.entryByRow.get(row).name);
  }
  isDirty() {
    const now = this.currentNames();
    return (
      now.length !== this.initialNames.length ||
      now.some((n, i) => n !== this.initialNames[i])
    );
  }
  async save() {
    if (!this.listEl) return false;
    const ok = this.core.saveFolderOrder(this.folder, this.currentNames());
    if (ok) this.initialNames = this.currentNames();
    return ok;
  }
  async navigateTo(folder) {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.app.vault.getFolderByPath?.(folder.path) !== folder) {
        new obsidian.Notice(this.zh() ? "该目录已不存在。" : "That folder is no longer there.");
        return;
      }
      if (this.isDirty()) {
        const saved = await this.save();
        if (!saved) return;
      }
      this.folder = folder;
      this.sortMode = "current";
      this.contentEl.empty();
      this.listEl = null;
      this.render();
    } finally {
      this.busy = false;
    }
  }
  resetAndRender() {
    this.contentEl.empty();
    this.listEl = null;
    this.render();
  }
  renderFooter(enabled) {
    const zh = this.zh();
    const footer = this.contentEl.createDiv({ cls: "eoe-footer" });
    const cancel = footer.createEl("button", { text: zh ? "取消" : "Cancel" });
    cancel.addEventListener("click", () => this.close());
    if (enabled) {
      const save = footer.createEl("button", {
        text: zh ? "保存" : "Save",
        cls: "mod-cta",
        attr: { type: "button" },
      });
      save.addEventListener("click", () => {
        void this.save().then((ok) => {
          if (ok) this.close();
        });
      });
    }
  }
}

// ---------------------------------------------------------------------------
// §4 BranchCore — native rewrite of the absorbed Branch Note layer
// ---------------------------------------------------------------------------
// Folder-as-page semantics: every folder can carry a home note (Folder/
// Folder.md); clicking a folder opens it; child notes live beside it; a
// plain note is promoted into a page when it gains its first child. Same
// behaviour as elfmedy/branch-note v0.1.4, re-typed for this plugin.
class BranchError extends Error {
  constructor(code, detail = "") {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}
function homeOf(fs, folder) {
  if (!folder || folder === "/" || fs.get(folder)?.kind !== "folder") return undefined;
  return fs
    .children(folder)
    .find((n) => n.kind === "file" && eqName(n.name, `${baseOf(folder)}.md`));
}
function pageFolder(fs, path) {
  if (fs.get(path)?.kind === "folder") return path;
  const parent = parentOf(path);
  return homeOf(fs, parent)?.path === path ? parent : undefined;
}
function visibleChildren(fs, folder) {
  const home = homeOf(fs, folder);
  return fs.children(folder).filter((n) => n.path !== home?.path);
}
function ensureAvailable(fs, path, except) {
  if (fs.children(parentOf(path)).some((n) => n.path !== except && eqName(n.name, baseOf(path))))
    throw new BranchError("conflict", path);
}
// All file operations run through a serial queue with best-effort rollback
// and a small undo history — the same safety net the original had.
class BranchService {
  constructor(fs) {
    this.fs = fs;
    this.tail = Promise.resolve();
    this.history = [];
  }
  get canUndo() {
    return this.history.length > 0;
  }
  drain() {
    return this.tail;
  }
  serial(fn) {
    const work = this.tail.then(fn);
    this.tail = work.catch(() => void 0);
    return work;
  }
  remember(undo) {
    this.history = [...this.history.slice(-19), undo];
  }
  async rollback(actions, error) {
    const failures = [];
    for (const action of actions.reverse()) {
      try {
        await action();
      } catch (e) {
        failures.push(String(e));
      }
    }
    if (failures.length)
      throw new BranchError("partial", `${String(error)}; ${failures.join("; ")}`);
    throw error;
  }
  // Create a child note for `path` (a home note or any markdown note),
  // promoting a plain note into "name/name.md + child" when needed.
  createChild(path, untitled) {
    return this.serial(async () => {
      const node = this.fs.get(path);
      if (!node) throw new BranchError("missing", path);
      const owner = pageFolder(this.fs, path);
      const promote = node.kind === "file" && !owner;
      if (promote && !/\.md$/i.test(node.name)) throw new BranchError("unsupported", path);
      const folder = owner ?? joinPath(parentOf(path), stemOf(node.name));
      if (promote) {
        if (!validName(stemOf(node.name))) throw new BranchError("invalidName", node.name);
        ensureAvailable(this.fs, folder);
      }
      let child = joinPath(folder, `${untitled}.md`),
        index = 1;
      while (
        eqName(baseOf(child), `${baseOf(folder)}.md`) ||
        this.fs.children(folder).some((n) => eqName(n.name, baseOf(child)))
      )
        child = joinPath(folder, `${untitled} ${index++}.md`);
      const original = promote ? await this.fs.read(path) : "";
      const home = joinPath(folder, node.name);
      const undo = [];
      try {
        if (promote) {
          await this.fs.mkdir(folder);
          undo.push(() => this.fs.removeEmpty(folder));
          await this.fs.rename(path, home);
          undo.push(async () => {
            ensureAvailable(this.fs, path);
            await this.fs.rename(home, path);
          });
        }
        await this.fs.create(child, "");
      } catch (e) {
        return this.rollback(undo, e);
      }
      this.remember(async () => {
        if (this.fs.get(child)?.kind !== "file" || (await this.fs.read(child)) !== "")
          throw new BranchError("changed", child);
        if (promote) {
          if (
            this.fs.children(folder).some((n) => n.path !== child && n.path !== home) ||
            this.fs.get(home)?.kind !== "file" ||
            (await this.fs.read(home)) !== original
          )
            throw new BranchError("changed", folder);
          ensureAvailable(this.fs, path);
        }
        await this.fs.trash(child);
        if (promote) {
          try {
            await this.fs.rename(home, path);
            await this.fs.removeEmpty(folder);
          } catch (e) {
            const restore = [];
            if (this.fs.get(path) && !this.fs.get(home)) restore.push(() => this.fs.rename(path, home));
            restore.unshift(() => this.fs.create(child, ""));
            return this.rollback(restore, e);
          }
        }
      });
      return { child, folder };
    });
  }
  createHome(folder) {
    return this.serial(async () => {
      if (!folder || folder === "/" || this.fs.get(folder)?.kind !== "folder")
        throw new BranchError("missing", folder);
      const home = homeOf(this.fs, folder);
      if (home) return home.path;
      const path = joinPath(folder, `${baseOf(folder)}.md`);
      ensureAvailable(this.fs, path);
      await this.fs.create(path, "");
      this.remember(async () => {
        if (this.fs.get(path)?.kind !== "file" || (await this.fs.read(path)) !== "")
          throw new BranchError("changed", path);
        await this.fs.trash(path);
      });
      return path;
    });
  }
  renameFolder(from, to, remember = true) {
    return this.serial(() => this.moveFolder(from, to, remember));
  }
  async moveFolder(from, to, remember) {
    if (from === to) return;
    if (!from || from === "/" || this.fs.get(from)?.kind !== "folder")
      throw new BranchError("missing", from);
    if (!validName(baseOf(to)) || to.startsWith(`${from}/`))
      throw new BranchError("invalidName", to);
    ensureAvailable(this.fs, to, from);
    const home = homeOf(this.fs, from),
      nextHome = joinPath(from, `${baseOf(to)}.md`);
    ensureAvailable(this.fs, nextHome, home?.path);
    const undo = [];
    try {
      if (home && home.path !== nextHome) {
        await this.fs.rename(home.path, nextHome);
        undo.push(() => this.fs.rename(nextHome, home.path));
      }
      await this.fs.rename(from, to);
    } catch (e) {
      return this.rollback(undo, e);
    }
    if (remember) this.remember(() => this.moveFolder(to, from, false));
  }
  // Follow a folder rename done OUTSIDE the plugin: rename its stale home
  // note (Old/Old.md inside New/) to match the new folder name.
  followExternalRename(from, to) {
    return this.serial(async () => {
      if (baseOf(from) === baseOf(to) || this.fs.get(to)?.kind !== "folder") return;
      const oldHome = this.fs
        .children(to)
        .find((n) => n.kind === "file" && eqName(n.name, `${baseOf(from)}.md`));
      if (!oldHome) return;
      const destination = joinPath(to, `${baseOf(to)}.md`);
      ensureAvailable(this.fs, destination, oldHome.path);
      if (oldHome.path !== destination) await this.fs.rename(oldHome.path, destination);
    });
  }
  deleteHome(folder) {
    return this.serial(async () => {
      const home = homeOf(this.fs, folder);
      if (!home) throw new BranchError("missing", folder);
      const content = await this.fs.read(home.path);
      await this.fs.trash(home.path);
      this.remember(async () => {
        if (this.fs.get(folder)?.kind !== "folder") throw new BranchError("missing", folder);
        ensureAvailable(this.fs, home.path);
        await this.fs.create(home.path, content);
      });
    });
  }
  undo() {
    return this.serial(async () => {
      const undo = this.history.at(-1);
      if (!undo) return;
      await undo();
      this.history.pop();
    });
  }
}
// Vault adapter. `templates` (optional) makes a never-edited templated child
// count as empty, so undo can still trash it.
class ObsidianFiles {
  constructor(app, move, templates) {
    this.app = app;
    this.move = move;
    this.templates = templates;
  }
  get(path) {
    const file = this.app.vault.getAbstractFileByPath(path || "/");
    return file
      ? {
          path: file.path,
          name: file.name,
          kind: file instanceof obsidian.TFolder ? "folder" : "file",
        }
      : undefined;
  }
  children(path) {
    const folder = this.app.vault.getAbstractFileByPath(path || "/");
    return folder instanceof obsidian.TFolder
      ? folder.children.map((file) => ({
          path: file.path,
          name: file.name,
          kind: file instanceof obsidian.TFolder ? "folder" : "file",
        }))
      : [];
  }
  file(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof obsidian.TFile)) throw new BranchError("missing", path);
    return file;
  }
  read(path) {
    const promise = this.app.vault.read(this.file(path));
    const templates = this.templates;
    if (!templates) return promise;
    return promise.then((result) => (templates.isPristine(path, result) ? "" : result));
  }
  async create(path, content) {
    const templates = this.templates;
    if (templates && content === "") {
      const templatePath = templates.applies(path);
      if (templatePath) {
        const injected = await templates.readFor(path, templatePath);
        if (injected != null) return await this.app.vault.create(path, injected);
      }
    }
    return await this.app.vault.create(path, content);
  }
  async mkdir(path) {
    await this.app.vault.createFolder(path);
  }
  async rename(from, to) {
    const file = this.app.vault.getAbstractFileByPath(from);
    if (!file) throw new BranchError("missing", from);
    await this.move(file, to);
  }
  async trash(path) {
    await this.app.fileManager.trashFile(this.file(path));
  }
  async removeEmpty(path) {
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!(folder instanceof obsidian.TFolder) || folder.children.length)
      throw new BranchError("changed", path);
    await this.app.fileManager.trashFile(folder);
  }
}
// Home notes only get special treatment where the explorer view's folder
// items carry the click semantics Branch Note relies on.
function canRepresentFolder(view, path) {
  return (
    typeof view.fileItems[path]?.onSelfClick === "function" &&
    typeof view.revealActiveFile === "function" &&
    typeof view.revealInFolder === "function"
  );
}
// Reveal the FOLDER (not the home note) when the active file is a home note.
function routeHomeReveals(view, fs) {
  let active = true;
  const cleanups = [];
  const folderItem = (file) => {
    const parent = parentOf(file.path);
    return canRepresentFolder(view, parent) && homeOf(fs, parent)?.path === file.path
      ? view.fileItems[parent]
      : undefined;
  };
  for (const method of ["revealActiveFile", "revealInFolder"]) {
    if (typeof view[method] !== "function") continue;
    const previous = view[method];
    const own = Object.hasOwn(view, method);
    const wrapped =
      method === "revealActiveFile"
        ? () => {
            const original = view.activeDom;
            const folder = active && original ? folderItem(original.file) : undefined;
            if (!folder) return previous.call(view);
            view.activeDom = folder;
            try {
              previous.call(view);
            } finally {
              if (view.activeDom === folder) view.activeDom = original;
            }
          }
        : (file) => {
            previous.call(view, (active && folderItem(file)?.file) || file);
          };
    view[method] = wrapped;
    cleanups.push(() => {
      if (view[method] === wrapped) {
        if (own) view[method] = previous;
        else delete view[method];
      }
    });
  }
  return () => {
    active = false;
    for (const cleanup of cleanups) cleanup();
  };
}
function isExplorer(value) {
  const view = value;
  return (
    !!view?.containerEl &&
    !!view.fileItems &&
    typeof view.getSortedFolderItems === "function" &&
    typeof view.requestSort === "function"
  );
}
// Wrap each explorer view INSTANCE: hide the home note, apply pins and sort
// modes. The previous prototype method is resolved through the CURRENT
// prototype chain on every call, so the layer order (OrderCore's prototype
// patch vs. this instance wrapper) never matters.
function filterHomes(view, fs, arrange) {
  const own = Object.hasOwn(view, "getSortedFolderItems");
  const captured = own ? view.getSortedFolderItems : undefined;
  let active = true;
  function filtered(folder) {
    const previous = own ? captured : Object.getPrototypeOf(view).getSortedFolderItems;
    let items = typeof previous === "function" ? previous.call(this, folder) : [];
    if (!active) return items;
    if (typeof arrange === "function") {
      try {
        items = arrange(folder.path, items);
      } catch (e) {
        console.error("[beautify] failed to apply the folder sort mode:", e);
      }
    }
    if (canRepresentFolder(this, folder.path)) {
      const home = homeOf(fs, folder.path);
      if (home) items = items.filter((item) => item.file.path !== home.path);
    }
    return items;
  }
  view.getSortedFolderItems = filtered;
  view.requestSort();
  return () => {
    active = false;
    if (view.getSortedFolderItems === filtered) {
      if (own) view.getSortedFolderItems = captured;
      else delete view.getSortedFolderItems;
    }
    view.requestSort();
  };
}

// ---- "start writing" view for folders without a home note ------------------
const HOME_VIEW = "branch-note-home";
class HomeView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  navigation = true;
  folder;
  busy = false;
  getViewType() {
    return HOME_VIEW;
  }
  getDisplayText() {
    return this.folder?.name ?? "Beautify";
  }
  getIcon() {
    return "file-text";
  }
  getState() {
    return { folder: this.folder?.path };
  }
  async setState(state, result) {
    const path = state?.folder;
    const folder = typeof path === "string" ? this.app.vault.getAbstractFileByPath(path) : null;
    this.folder = folder instanceof obsidian.TFolder ? folder : undefined;
    this.render();
    await super.setState(state, result);
  }
  async render() {
    this.contentEl.empty();
    this.contentEl.addClass("bn-home");
    if (!this.folder) return;
    // v2.8.1: rebuild the EXACT DOM the reading view's renderer builds
    // (verified against Obsidian's app.js and a live document's DOM):
    // view-content > markdown-reading-view (100%×100%) > markdown-preview-view
    // .markdown-rendered (fold / indent-guide classes follow their config) >
    // sizer/section > pusher (1px×0.1px) + mod-header.mod-ui > inline-title,
    // then .el-p content blocks. Deliberately NOT mirrored: the hidden
    // markdown-source-view sibling (no edit mode here), metadata-container
    // (display:none and driven by the metadata editor), inline-title's
    // contenteditable attrs (renaming is not wired here), sizer's runtime
    // scroll metrics, and node-insert-event (Obsidian dev-tools noise).
    const cfg = (key) => this.app.vault.getConfig?.(key) !== false;
    const readingView = this.contentEl.createDiv({ cls: "bn-home-body markdown-reading-view" });
    readingView.style.width = "100%";
    readingView.style.height = "100%";
    const page = readingView.createDiv({
      cls:
        "markdown-preview-view markdown-rendered" +
        (cfg("foldHeading") ? " allow-fold-headings" : "") +
        (cfg("foldIndent") ? " allow-fold-lists" : "") +
        (cfg("showIndentGuide") ? " show-indentation-guide" : "") +
        (cfg("readableLineLength") ? " is-readable-line-width" : ""),
      attr: { tabindex: "-1" },
    });
    const sizer = page.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
    const pusher = sizer.createDiv({ cls: "markdown-preview-pusher" });
    pusher.style.width = "1px";
    pusher.style.height = "0.1px";
    const header = sizer.createDiv({ cls: "mod-header mod-ui" });
    header.createEl("div", { text: this.folder.name, cls: "inline-title" });
    // The hint paragraph goes through Obsidian's markdown pipeline
    // (MarkdownRenderer.render appends bare blocks) inside the same .el-p
    // block wrapper a document uses. Plain-<p> fallback keeps the page
    // usable if the renderer API ever changes shape.
    const hint = sizer.createDiv({ cls: "el-p bn-home-hint" });
    const description = this.plugin.t("emptyDescription");
    try {
      await obsidian.MarkdownRenderer.render(this.app, description, hint, this.folder.path, this);
    } catch (e) {
      console.warn("[beautify] markdown render failed, falling back to plain text:", e);
      hint.createEl("p", { text: description, cls: "bn-home-description" });
    }
    const actions = sizer.createDiv({ cls: "bn-home-actions" });
    const start = actions.createEl("button", {
      text: this.plugin.t("start"),
      cls: "mod-cta bn-start",
    });
    start.disabled = this.busy;
    start.addEventListener("click", () => {
      if (this.busy || !this.folder) return;
      this.busy = true;
      start.disabled = true;
      const folder = this.folder;
      void this.plugin.service
        .createHome(folder.path)
        .then(async (path) => {
          this.plugin.refresh();
          if (this.leaf.view === this && this.folder === folder)
            await this.plugin.openMarkdown(path, this.leaf);
        })
        .catch((error) => this.plugin.report(error))
        .finally(() => {
          this.busy = false;
          start.disabled = false;
        });
    });
  }
  updateLanguage() {
    // The hint is markdown-rendered, so rebuild the page to re-render the
    // text (and the button label) in the new language.
    void this.render();
  }
}
// ---- unsaved draft recovery ------------------------------------------------
class RecoveryModal extends obsidian.Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }
  onOpen() {
    this.setTitle(this.plugin.t("recover"));
    this.contentEl.addClass("bn-recovery");
    this.contentEl.createEl("p", { text: this.plugin.t("recoveryHelp") });
    for (const draft of Object.values(this.plugin.drafts)) {
      this.contentEl.createEl("h3", { text: draft.folder });
      const field = this.contentEl.createEl("textarea", {
        attr: { "aria-label": draft.folder, readonly: "" },
      });
      field.value = draft.content;
      this.contentEl
        .createEl("button", { text: this.plugin.t("selectText") })
        .addEventListener("click", () => {
          field.focus();
          field.select();
        });
    }
  }
  onClose() {
    this.contentEl.empty();
  }
}
// ---- i18n -------------------------------------------------------------------
const I18N_EN = {
  language: "Language",
  auto: "Follow Obsidian",
  languageDescription: "Choose the language used by Beautify.",
  newChild: "New child note",
  untitled: "Untitled",
  start: "Start writing",
  empty: "A home for this page",
  emptyDescription:
    "This folder has no home note yet. Start writing to create one and open it in the editor.",
  done: "Done",
  saved: "Saved",
  saving: "Saving…",
  retry: "Retry save",
  deleteHome: "Delete home note",
  undo: "Undo last page action",
  undone: "Last page action undone.",
  created: "Child note created.",
  deleted: "Home note moved to trash. Child pages are preserved.",
  recover: "Recover unsaved page",
  conflict: "A file or folder already occupies this path. Nothing will be overwritten.",
  missing: "The page or file no longer exists.",
  unsupported: "Only Markdown notes can have child notes.",
  invalidName: "Choose a valid folder name without reserved characters.",
  changed: "The file changed elsewhere. Your action was stopped to preserve those changes.",
  partial: "The operation could not be fully restored. Review the affected paths before continuing.",
  failure: "The operation failed. Your files have not been intentionally overwritten.",
  unsaved:
    "Could not save this page. The draft is retained; use Recover unsaved page to reopen it.",
  chooseRecovery: "No unsaved page drafts to recover.",
  recoveryHelp:
    "Copy the text below into a note. Drafts remain available even if their original folder was moved or deleted.",
  selectText: "Select text",
  toggleHidden: "Toggle hidden files",
  setOrderRoot: "Set explorer order for vault root",
  clearOrderRoot: "Clear explorer order for vault root",
  moveUp: "Move up",
  moveDown: "Move down",
  moveTop: "Move to top",
  moveBottom: "Move to bottom",
};
const I18N_ZH = {
  language: "语言",
  auto: "跟随 Obsidian",
  languageDescription: "选择 Beautify 使用的界面语言。",
  newChild: "新建子笔记",
  untitled: "未命名",
  start: "开始书写",
  empty: "从这里,开始书写",
  emptyDescription: "这个目录还没有首页。点击“开始书写”,即可创建首页并打开编辑器。",
  done: "完成书写",
  saved: "已保存",
  saving: "正在保存……",
  retry: "重试保存",
  deleteHome: "删除首页",
  undo: "撤销上次页面操作",
  undone: "已撤销上次页面操作。",
  created: "已新建子笔记。",
  deleted: "首页已移至回收站,目录和子条目保留。",
  recover: "恢复未保存的页面",
  conflict: "目标路径已有文件或目录,操作已停止,不会覆盖。",
  missing: "页面或文件已不存在。",
  unsupported: "只有 Markdown 笔记可以创建子笔记。",
  invalidName: "请使用有效名称,不要包含路径符号或系统保留名称。",
  changed: "文件已被其他操作修改,本次操作已停止,以保留这些更改。",
  partial: "操作未能完整恢复,请检查相关路径后再继续。",
  failure: "操作失败,未主动覆盖任何已有文件。",
  unsaved: "页面保存失败,草稿已保留,可通过“恢复未保存的页面”重新打开。",
  chooseRecovery: "没有需要恢复的草稿。",
  recoveryHelp: "可复制下方文本并粘贴到笔记中。即使原目录已移动或删除,草稿仍会保留。",
  selectText: "选择全文",
  toggleHidden: "显示/隐藏被隐藏的文件",
  setOrderRoot: "设置库根目录排序",
  clearOrderRoot: "清除库根目录排序",
  moveUp: "上移",
  moveDown: "下移",
  moveTop: "移到顶部",
  moveBottom: "移到底部",
};
const languageFrom = (value) => (value === "zh" || value === "en" ? value : "auto");
const resolveLanguage = (language, obsidianLanguage) =>
  language === "auto"
    ? obsidianLanguage.toLowerCase().startsWith("zh")
      ? "zh"
      : "en"
    : language;
const translate = (language, key) => (language === "zh" ? I18N_ZH : I18N_EN)[key] ?? key;
// ---------------------------------------------------------------------------
// Icon picker (simplified Iconic): search + random + remove.
// Data format: "emoji 关键词,关键词|emoji 关键词|…" parsed once.
// ---------------------------------------------------------------------------
var EMOJI_SOURCE =
  "😀 笑,开心,smile|😃 笑,开心|😄 笑,开心|😁 笑,得意|😆 哈哈|😅 笑,尴尬,汗|😂 笑哭,joy|🤣 大笑|😊 微笑,害羞|☺️ 微笑|😍 喜欢,爱|🥰 爱,喜爱|😘 亲,吻|😗 吻|😙 吻|😚 吻|🙂 微笑|🙃 倒立,无奈|😉 眨眼|😋 好吃|😛 吐舌|😜 吐舌,眨眼|🤪 搞怪|🤨 挑眉|😐 无语|😑 无语|🙄 白眼|😏 坏笑|😒 不屑|😞 失望|😔 沮丧|😟 担心|🤒 生病,发烧|🤕 受伤|🤢 恶心|🤮 吐|😯 惊|😨 害怕|😰 焦虑,汗|😥 失望|😢 哭|😭 大哭|😱 尖叫,吓|😖 困扰|😣 坚持|😩 累|😫 累|🥱 哈欠|😴 睡|😌 安心|🤔 思考,想|🤯 惊,懵|😶 沉默|🙊 不说|🙉 不听|🙈 不看|💋 唇|💘 心,箭|❤️ 红,爱,心|🧡 橙,爱|💛 黄,爱|💚 绿,爱|💙 蓝,爱|💜 紫,爱|🖤 黑,爱|🤍 白,爱|💔 心碎|❣️ 感叹|💕 双心|💞 旋转,心|💓 跳动,心|💗 心|💖 闪,心|💝 心,礼盒|✨ 闪,亮点|⭐ 星,收藏|🌟 闪,星|⚡ 闪电,电|🔥 火,热门|❄️ 雪,冰|☀️ 太阳,晴|🌙 月亮|⛅ 多云|☁️ 云|🌈 彩虹|☂️ 伞|⛄ 雪人" +
  "|👍 赞,好,like|👎 踩,差|👌 OK,好|✌️ 胜利,耶|🤞 交叉,希望|🤟 爱你|🤘 摇滚|👏 鼓掌|🙌 欢呼|👐 张开|🤲 摊手|🤝 握手,合作|🙏 拜,谢谢,请|💪 力量,强|✍️ 写|✋ 停,举手|🖐️ 手|🤚 举手|👋 招手,hi|👈 左|👉 右|👆 上|👇 下|☝️ 上指|✒️ 笔尖" +
  "|👀 眼,看|🧠 大脑,思考|👤 人|👥 人们,组|👶 婴儿|👦 男孩|👧 女孩|👨 男|👩 女|🧑 人|👴 老人|👵 老太|🧑‍💻 程序员,编码|🧑‍🏫 老师|🧑‍⚕️ 医生|🧑‍🎨 画家,设计|🧑‍🔬 科学家|🧑‍💼 商务|🕵️ 侦探|👮 警察|💃 舞蹈|🕺 舞蹈|🧘 冥想,瑜伽|🏃 跑步|🚶 走路|🧗 攀爬|🏊 游泳|🚴 骑车|⛷️ 滑雪|🏄 冲浪" +
  "|🐶 狗|🐱 猫|🐭 鼠|🐹 仓鼠|🐰 兔|🦊 狐狸|🐻 熊|🐼 熊猫|🐨 考拉|🐯 虎|🦁 狮|🐮 牛|🐷 猪|🐸 蛙|🐵 猴|🐔 鸡|🐧 企鹅|🐦 鸟|🦆 鸭|🦅 鹰|🦉 猫头鹰|🦇 蝙蝠|🐺 狼|🐴 马|🦄 独角兽|🐝 蜜蜂|🐛 毛虫|🦋 蝴蝶|🐌 蜗牛|🐞 瓢虫|🐜 蚂蚁|🕷️ 蜘蛛|🦂 蝎|🐢 龟|🐍 蛇|🦎 蜥蜴|🐙 章鱼|🦑 鱿鱼|🦐 虾|🦀 蟹|🐡 河豚|🐠 鱼缸|🐟 鱼|🐬 海豚|🐳 鲸|🦈 鲨鱼|🐊 鳄鱼|🐘 象|🦏 犀牛|🦛 河马|🦒 长颈鹿|🦓 斑马|🦌 鹿|🐃 水牛|🐄 奶牛|🐎 马|🐑 绵羊|🐐 山羊|🦃 火鸡|🕊️ 鸽子,和平|🦝 浣熊|🦫 河狸|🦦 水獭|🦥 树懒|🐿️ 松鼠|🦔 刺猬" +
  "|🍎 苹果|🍐 梨|🍊 橙|🍋 柠檬|🍌 香蕉|🍉 西瓜|🍇 葡萄|🍓 草莓|🫐 蓝莓|🍈 甜瓜|🍒 樱桃|🍑 桃|🥭 芒果|🍍 菠萝|🥥 椰子|🥝 猕猴桃|🍅 番茄|🥑 牛油果|🍆 茄子|🥕 胡萝卜|🌽 玉米|🌶️ 辣椒|🥔 土豆|🧄 蒜|🧅 洋葱|🥦 西兰花|🥬 白菜|🥒 黄瓜|🍄 蘑菇|🥜 花生|🌰 栗子|🍞 面包|🥐 牛角包|🥖 法棍|🥨 碱水圈|🧀 奶酪|🥚 鸡蛋|🍳 煎蛋|🥞 薄饼|🧇 华夫|🥓 培根|🍗 鸡腿|🍖 肉|🌭 热狗|🍔 汉堡|🍟 薯条|🍕 披萨|🥪 三明治|🌮 墨西哥卷|🌯 卷饼|🥙 卷|🍜 拉面|🍝 意面|🍲 汤锅|🍛 咖喱|🍣 寿司|🍱 便当|🍚 米饭|🍥 鱼糕|🥟 饺子|🍤 天妇罗|🍦 冰淇淋|🍩 甜甜圈|🍪 饼干|🎂 蛋糕|🍰 蛋糕|🧁 纸杯蛋糕|🥧 派|🍫 巧克力|🍬 糖|🍭 棒棒糖|🍮 布丁|🍯 蜂蜜|🥛 牛奶|☕ 咖啡|🍵 茶|🧋 奶茶|🥤 饮料,汽水|🍺 啤酒|🍻 干杯|🍷 红酒|🥂 庆祝,干杯|🍸 鸡尾酒|🥃 威士忌|🧊 冰" +
  "|🚗 汽车|🚕 出租车|🚙 越野|🚌 公交|🏎️ 赛车|🚓 警车|🚑 救护车|🚒 消防车|🚚 货车|🚛 卡车|🚜 拖拉机|🛴 滑板车|🚲 自行车|🛵 电动车|🏍️ 摩托|✈️ 飞机|🛫 起飞|🛬 降落|🚀 火箭|🛸 飞碟|🚁 直升机|⛵ 帆船|🚢 轮船|⚓ 锚|🗺️ 地图|🧭 指南针|🏔️ 山|🌋 火山|🏕️ 露营|🏖️ 海滩|🏝️ 岛|🏜️ 沙漠|🌅 日出|🌄 日出|🌇 日落|🌆 黄昏|🌃 夜景|🏙️ 城市|🏰 城堡|🗼 塔|🗽 自由女神|🎡 摩天轮|🎢 过山车|🎠 旋转木马|⛲ 喷泉|⛩️ 鸟居|⛺ 帐篷" +
  "|⌚ 手表|📱 手机|☎️ 电话|📞 电话|📟 寻呼|📠 传真|🔋 电池|🔌 插头|💻 电脑,笔记本|🖥️ 显示器|⌨️ 键盘|🖱️ 鼠标|💾 保存,软盘|💿 光盘|🧮 算盘|🎥 摄影机|📷 相机|📸 相机|📹 摄像|📼 录像带|🎬 电影,场记板|🎤 麦克风|🎧 耳机|📻 收音机|🎷 萨克斯|🎸 吉他|🎹 键盘,钢琴|🎺 小号|🎻 小提琴|🥁 鼓|🎮 游戏手柄|🕹️ 摇杆|🎲 骰子|🎯 靶心,目标|👓 眼镜|🕶️ 墨镜|👔 领带|👕 T恤|👖 牛仔裤|🧥 外套|🧦 袜子|👗 裙|👘 和服|👙 泳装|👜 手包|👝 钱包|🎒 背包|🌂 伞|☂️ 伞|👑 皇冠|🎓 学位帽|🧢 棒球帽|🎩 礼帽|💍 戒指|💄 口红" +
  "|💡 灯泡,想法|🔦 手电|🕯️ 蜡烛|🧯 灭火器|💰 钱袋|🧾 账单,收据|💎 钻石|⚖️ 天平,法律|🔗 链接|⛓️ 链|🔧 扳手|🔨 锤子|🪛 螺丝刀|🔩 螺母|🪓 斧头|🔪 刀|🗡️ 剑|⚔️ 剑|🛡️ 盾|🏺 花瓶|🔮 水晶球|🧿 护身符|📿 念珠|💈 理发|🧪 试管|🧫 培养|🧬 dna|🔬 显微镜|🔭 望远镜|📡 天线|💉 注射|🩹 创可贴|🩺 听诊器|🚪 门|🛏️ 床|🛋️ 沙发|🚽 厕所|🚿 淋浴|🛁 浴缸|🧴 瓶|🧹 扫帚|🧺 篮|🧼 肥皂|🧽 海绵|🛒 购物车|🎁 礼物|🎈 气球|🎏 鲤鱼旗|🎀 蝴蝶结|🎉 庆祝,派对|🎊 撒花" +
  "|✅ 完成,勾,done|❌ 错,叉,删除|⭕ 圆|⛔ 禁止|🚫 禁止|❗ 感叹|❓ 问号|⁉️ 感叹问|💯 满分,百分|💥 爆炸|💫 头晕|⚠️ 警告|♻️ 回收,循环|🔱 三叉|🏁 终点|🚩 旗|🔴 红点|🟠 橙点|🟡 黄点|🟢 绿点|🔵 蓝点|🟣 紫点|⚫ 黑点|⚪ 白点|🟤 棕点|🔺 红三角|♠️ 黑桃|♥️ 红桃|♦️ 方块|♣️ 梅花|🃏 大王|🀄 麻将|🎴 花牌" +
  "|⚽ 足球|🏀 篮球|🏈 橄榄|🎾 网球|🏐 排球|🥏 飞盘|🎳 保龄球|🏏 板球|🏑 曲棍球|🏒 冰球|🏓 乒乓球|🏸 羽毛球|🥊 拳击|🥋 武术|⛳ 高尔夫|⛸️ 滑冰|🎣 钓鱼|🤿 潜水|🎽 运动服|🎿 滑雪|🛷 雪橇|🥌 冰壶|🏆 奖杯,冠军|🥇 金牌|🥈 银牌|🥉 铜牌|🏅 奖牌|🎖️ 勋章|🎫 门票|🎪 马戏|🎭 戏剧|🎨 调色,艺术|🎼 乐谱" +
  "|📚 书,学习|📖 打开的书|📒 日记|📓 笔记本|📃 页|📜 卷轴|📄 文档|📊 图表|📈 上升|📉 下降|🗓️ 日历|📅 日历|📇 卡片|🗂️ 文件夹|🗃️ 卡片盒|🗄️ 文件柜|📋 剪贴板|📁 文件夹|📂 打开文件夹|🗑️ 垃圾,删除|🔒 锁|🔓 解锁|🔑 钥匙|🗝️ 钥匙|🔔 铃|🔕 静音|📢 喇叭|✉️ 信,邮件|📧 邮件|📬 信箱|📮 邮筒|📝 备忘,写|✏️ 铅笔|✒️ 钢笔|🖊️ 笔|🖌️ 画笔|🖍️ 蜡笔|📌 图钉|📍 位置|📎 回形针|📏 尺|📐 三角尺|✂️ 剪刀|🐉 龙|🌵 仙人掌|🎄 圣诞树|🌲 树|🌳 树|🌴 棕榈|🌱 幼苗|🌿 草|☘️ 三叶草|🍀 四叶草,幸运|🍁 枫叶|🍂 落叶|🍃 叶|💐 花束|🌷 郁金香|🌹 玫瑰|🥀 枯萎|🌺 花|🌸 樱花|🌼 花|🌻 向日葵|🌞 太阳|🌝 月亮|🌍 地球|🌎 地球|🌏 地球|🌐 网络,全球";
var EMOJI_LIST = null;
function emojiList() {
  if (EMOJI_LIST) return EMOJI_LIST;
  EMOJI_LIST = [];
  var parts = EMOJI_SOURCE.split("|");
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (!part) continue;
    var sp = part.indexOf(" ");
    if (sp <= 0) continue;
    var e = part.slice(0, sp);
    var k = part.slice(sp + 1).toLowerCase();
    if (!e || /[a-zA-Z一-鿿]/.test(e)) continue; // skip malformed entries
    EMOJI_LIST.push({ e: e, k: k });
  }
  return EMOJI_LIST;
}
// Curated lucide icons ("name 关键词|…" — ASCII names render via setIcon).
var LUCIDE_SOURCE =
  "folder 文件夹,目录|folder-open 文件夹打开|folder-plus 新建文件夹|file 文件|file-text 文档,笔记|file-plus 新建文件|files 多文件|copy 复制|clipboard 剪贴板|clipboard-list 清单|notebook 笔记本|book 书|book-open 打开书|library 书库|graduation-cap 学习|pen 笔|pencil 铅笔|edit 编辑|edit-2 编辑|feather 羽毛笔|highlighter 荧光笔|eraser 橡皮|scissors 剪刀|paperclip 回形针|link 链接|unlink 取消链接|hash 标签|tag 标签|bookmark 书签|star 星,收藏|heart 爱|thumbs-up 赞|search 搜索|filter 过滤|sort-asc 升序|calendar 日历|clock 时间,时钟|alarm-clock 闹钟|timer 计时|history 历史|refresh 循环,刷新|rotate-cw 重做|undo-2 撤销|check 完成,勾|check-circle 完成|x 错|x-circle 错误|alert-triangle 警告|info 信息|help-circle 帮助,问号|lightbulb 想法,灯泡|brain 思考,脑|sparkles 闪亮,灵感|zap 闪电,快速|flame 火焰,热门|rocket 火箭,启动|target 目标|trophy 奖杯|medal 奖牌|award 奖励|crown 皇冠|gem 钻石|shield 盾牌,安全|lock 锁|unlock 解锁|key 钥匙|bug 缺陷|wrench 扳手,工具|hammer 锤子|settings 设置,齿轮|sliders 调节|database 数据库|server 服务器|cloud 云|wifi 网络|globe 地球,网络|monitor 显示器|laptop 笔记本电脑|keyboard 键盘|mouse 鼠标|smartphone 手机|tablet 平板|battery 电池|plug 插头,电源|cpu 处理器|hard-drive 硬盘|save 保存|download 下载|upload 上传|inbox 收件箱|send 发送|mail 邮件|message-circle 消息,聊天|messages-square 消息|user 用户|users 用户组,团队|contact 身份|home 主页,家|map 地图|compass 指南针|navigation 导航|route 路线|signpost 路标|flag 旗|anchor 锚|plane 飞机|car 汽车|bike 自行车|train 火车|ship 轮船|truck 卡车|shopping-cart 购物车|shopping-bag 购物袋|credit-card 银行卡|wallet 钱包|currency 钱,货币|trending-up 上升|trending-down 下降|bar-chart 图表|pie-chart 饼图|line-chart 折线|activity 活动,脉搏|camera 相机|image 图片|film 影片|music 音乐|headphones 耳机|mic 麦克风|play 播放|pause 暂停|skip-forward 快进|volume 音量|radio 广播|tv 电视|gamepad 游戏|puzzle 拼图|gift 礼物|party-popper 庆祝|cake 蛋糕|coffee 咖啡|utensils 餐具|apple 苹果|leaf 叶子|flower 花|tree 松树|sun 太阳|moon 月亮|cloud-rain 下雨|snowflake 雪|rainbow 彩虹|mountain 山|ocean 海洋|bird 鸟|fish 鱼|rabbit 兔子|turtle 龟" +
  "|building 建筑|building-2 楼宇|factory 工厂|warehouse 仓库|store 商店|tent 帐篷|house 房子|castle 城堡|landmark 地标|hospital 医院|school 学校|briefcase 公文包|archive 档案|box 盒子|package 包裹|package-open 拆包|package-check 包裹勾|package-plus 包裹加|boxes 多盒|container 集装箱|vault 保险箱|safe 保险柜|piggy-bank 存钱罐|banknote 钞票|coins 硬币|receipt 收据|badge 徽章|id-card 证件|fingerprint 指纹|qr-code 二维码|barcode 条形码|scan 扫描|radar 雷达|calculator 计算器|printer 打印机|backpack 背包|suitcase 行李箱|luggage 行李|handbag 手提包|watch 手表|glasses 眼镜|paintbrush 画笔|paint-roller 滚筒|palette 调色板|ruler 尺|toy-brick 积木|axe 斧头|pickaxe 镐|shovel 铲|tractor 拖拉机|magnet 磁铁|candle 蜡烛|flashlight 手电|battery-charging 充电|battery-full 满电|battery-medium 半电|battery-low 低电|cable 线缆|sim-card 电话卡|sd-card 存储卡|memory-stick 内存条|chip 芯片|circuit-board 电路板|thermometer 温度计|gauge 仪表|droplet 水滴|droplets 水滴|waves 波浪|wind 风|tornado 龙卷风|radiation 辐射|biohazard 生化|skull 骷髅|ghost 幽灵|pumpkin 南瓜|candy 糖果|candy-cane 拐杖糖|tree-christmas 圣诞树|ribbon 缎带|ticket 门票|ticket-check 检票|ticket-percent 优惠券" +
  "|square 方块|circle 圆|triangle 三角|hexagon 六边形|pentagon 五边形|octagon 八边形|diamond 菱形|shapes 形状|grid-2x2 网格|grid-3x3 网格|layout-grid 布局|layout-list 列表布局|columns 列|rows 行|kanban 看板|list 列表|list-ordered 有序列表|list-tree 树状列表|list-check 清单|list-filter 筛选列表|table 表格|network 网络|workflow 流程|git-branch 分支|git-merge 合并|git-fork 分叉|git-pull-request 拉取|git-commit 提交|arrow-up 上箭头|arrow-down 下箭头|arrow-left 左箭头|arrow-right 右箭头|arrow-up-right 右上|arrow-up-left 左上|arrow-down-right 右下|arrow-down-left 左下|arrow-up-down 上下|arrow-left-right 左右|move 移动|maximize 最大化|minimize 最小化|expand 展开|shrink 收缩|trash 垃圾桶|trash-2 垃圾桶|clipboard-paste 粘贴|clipboard-copy 复制|clipboard-check 剪贴勾" +
  "|tree-pine 松树|tree-deciduous 落叶树|tree-palm 棕榈|trees 树林|sprout 幼苗|seedling 种子|flower-2 花|mountain-snow 雪山|shell 贝壳|fish-symbol 鱼|cat 猫|dog 狗|squirrel 松鼠|hedgehog 刺猬|snail 蜗牛|bug 虫|ladybug 瓢虫|paw-print 爪印|bone 骨头|egg 蛋|egg-fried 煎蛋|milk 牛奶|cup-soda 汽水|cocktail 鸡尾酒|martini 马天尼|ice-cream 冰淇淋|pizza 披萨|sandwich 三明治|soup 汤|salad 沙拉|banana 香蕉|grape 葡萄|cherry 樱桃|pear 梨|carrot 胡萝卜|citrus 柑橘|cookie 饼干|cake-slice 蛋糕|croissant 牛角包|beef 牛肉|ham 火腿|drumstick 鸡腿|guitar 吉他|piano 钢琴|music-2 音乐|podcast 播客|clapperboard 场记板|video 视频|video-off 关闭视频|projector 投影仪|airplay 投屏|radio-tower 广播塔|antenna 天线|satellite 卫星|satellite-dish 卫星锅|signal 信号|bluetooth 蓝牙|wifi-off 断网|cloud-download 云下载|cloud-upload 云上传|cloudy 多云|cloud-fog 雾|cloud-lightning 雷雨|cloud-snow 雪云|cloud-sun 晴云|sunrise 日出|sunset 日落|moon-star 星月|sparkle 闪" +
  "|car-front 车前|car-taxi-front 出租|bus 公交|sailboat 帆船|fuel 燃油|gas-pump 油泵|charging-station 充电站|train-front 火车|rail-symbol 铁路|tram-front 电车|cable-car 缆车|plane-takeoff 起飞|plane-landing 降落|footprints 脚印|map-pin 图钉|map-pinned 定位|crosshair 准星|locate 定位|locate-fixed 定位|navigation-2 导航|headphone 耳机|ear 耳|eye 眼|eye-off 闭眼|smile 微笑|frown 皱眉|meh 无感|laugh 大笑|angry 生气|annoyed 烦恼|confused 困惑|dizzy 晕|wand 魔杖|wand-sparkles 魔法|drum 鼓";
var LUCIDE_LIST = null;
function lucideList() {
  if (LUCIDE_LIST) return LUCIDE_LIST;
  LUCIDE_LIST = [];
  var parts = LUCIDE_SOURCE.split("|");
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    var sp = part.indexOf(" ");
    if (sp <= 0) continue;
    LUCIDE_LIST.push({ e: part.slice(0, sp), k: part.slice(sp + 1).toLowerCase() });
  }
  return LUCIDE_LIST;
}
var IconPickerModal = class extends obsidian.Modal {
  // file: the TFile whose icon is edited; OR null + task hooks (v1.8.0):
  // task = { current(): string|null, pick(emoji|null): void } — reuses the
  // same emoji/lucide library for task icons.
  constructor(app, plugin, file, task) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.task = task || null;
    this.query = "";
    this.mode = "emoji";
  }
  __apply(emoji) {
    if (this.task) this.task.pick(emoji);
    else void this.plugin.setExtraIcon(this.file, emoji);
  }
  onOpen() {
    var zh = this.plugin.isZh();
    this.setTitle(zh ? "设置图标" : "Set icon");
    this.modalEl.addClass("bn-icon-modal");
    var current = this.task ? this.task.current() : this.plugin.extraIconOf(this.file.path);
    var top = this.contentEl.createEl("div", { cls: "bn-icon-top" });
    if (current) top.createEl("span", { cls: "bn-icon-current", text: current });
    var self = this;
    var emojiBtn = top.createEl("button", {
      text: zh ? "表情" : "Emoji",
      cls: "bn-icon-btn bn-icon-mode",
    });
    var lucideBtn = top.createEl("button", {
      text: zh ? "线条" : "Lucide",
      cls: "bn-icon-btn bn-icon-mode",
    });
    emojiBtn.addEventListener("click", function () {
      self.mode = "emoji";
      self.__shown = null;
      self.renderModes(emojiBtn, lucideBtn);
      self.renderGrid();
    });
    lucideBtn.addEventListener("click", function () {
      self.mode = "lucide";
      self.__shown = null;
      self.renderModes(emojiBtn, lucideBtn);
      self.renderGrid();
    });
    var input = top.createEl("input", { type: "search", cls: "bn-icon-input" });
    input.placeholder = zh ? "搜索图标(如:狗 / 咖啡 / 火箭)" : "Search icons (e.g. dog / coffee / rocket)";
    input.addEventListener("input", function () {
      self.search(input.value);
    });
    var actions = top.createEl("div", { cls: "bn-icon-actions" });
    var randomBtn = actions.createEl("button", {
      text: zh ? "随机" : "Random",
      cls: "bn-icon-btn",
    });
    randomBtn.addEventListener("click", function () {
      self.pickRandom();
    });
    if (current) {
      var removeBtn = actions.createEl("button", {
        text: zh ? "移除" : "Remove",
        cls: "bn-icon-btn mod-warning",
      });
      removeBtn.addEventListener("click", function () {
        self.__apply(null);
        self.close();
      });
    }
    this.renderModes(emojiBtn, lucideBtn);
    this.gridEl = this.contentEl.createEl("div", { cls: "bn-icon-grid" });
    this.search("");
  }
  renderModes(emojiBtn, lucideBtn) {
    try {
      if (typeof emojiBtn.removeClass === "function") {
        emojiBtn.removeClass("is-active");
        emojiBtn.removeClass("is-inactive");
        lucideBtn.removeClass("is-active");
        lucideBtn.removeClass("is-inactive");
      }
      var on = "is-active", off = "is-inactive";
      if (typeof emojiBtn.addClass === "function")
        emojiBtn.addClass(this.mode === "emoji" ? on : off);
      if (typeof lucideBtn.addClass === "function")
        lucideBtn.addClass(this.mode === "lucide" ? on : off);
    } catch (e) {
      /* cosmetic */
    }
  }
  matches() {
    var list = this.mode === "lucide" ? lucideList() : emojiList();
    if (!this.query) return list;
    var q = this.query;
    return list.filter(function (x) {
      return x.k.indexOf(q) !== -1 || x.e === q;
    });
  }
  search(value) {
    this.query = String(value || "").trim().toLowerCase();
    this.__shown = null; // reset chunking on a new search
    this.renderGrid();
  }
  renderGrid() {
    var zh = this.plugin.isZh();
    this.gridEl.empty();
    var list = this.matches();
    if (!list.length) {
      this.gridEl.createEl("div", {
        cls: "bn-icon-empty",
        text: zh ? "没有匹配的图标" : "No matching icons",
      });
      return;
    }
    var self = this;
    // Render in chunks so the modal stays light; "show more" appends the rest.
    var limit = Math.min(this.__shown || 240, list.length);
    this.__shown = limit;
    for (var i = 0; i < limit; i++) {
      (function (entry) {
        var cell = self.gridEl.createEl("button", { cls: "bn-icon-cell" });
        if (self.mode === "lucide") {
          try {
            (0, obsidian.setIcon)(cell, entry.e);
          } catch (e) {
            /* unknown name */
          }
        } else if (typeof cell.setText === "function") {
          cell.setText(entry.e);
        } else {
          cell.textContent = entry.e;
        }
        if (typeof cell.setAttribute === "function")
          cell.setAttribute("title", entry.e + " · " + entry.k.replace(/,/g, " / "));
        cell.addEventListener("click", function () {
          self.__apply(entry.e);
          self.close();
        });
      })(list[i]);
    }
    if (list.length > limit) {
      var more = this.gridEl.createEl("button", {
        cls: "bn-icon-more",
        text:
          zh ? "显示更多(" + (list.length - limit) + ")" : "Show more (" + (list.length - limit) + ")",
      });
      more.addEventListener("click", function () {
        self.__shown = limit + 240;
        self.renderGrid();
      });
    }
  }
  pickRandom() {
    var list = this.matches().length ? this.matches() : this.mode === "lucide" ? lucideList() : emojiList();
    var entry = list[Math.floor(Math.random() * list.length)];
    if (entry) {
      this.__apply(entry.e);
      this.close();
    }
  }
  onClose() {
    // Release the parsed icon data; it re-parses on the next open.
    EMOJI_LIST = null;
    LUCIDE_LIST = null;
    this.contentEl.empty();
  }
};


// ---- task management (v2.1.0, rebuilt on the obsidian-tasks model) ---------
// A task line is plain markdown:  <indent><marker> [status] description…
// and ALL metadata lives INLINE as emoji fields at the line end — portable,
// synced with the vault, visible in every editor (no CodeMirror needed):
//   ➕ 2026-11-02  created      ✅ 2026-11-03  done         ❌ cancelled date
//   🛫 start       ⏳ scheduled  📅 due        🔺⏫🔼🔽⏬  priority
// The task's ICON is the first emoji of the description (inline text too).
// Parsing follows obsidian-tasks' end-anchored strip loop, so fields are
// accepted in any order (and ️ variant selectors are tolerated).
// <indent (incl. blockquote/callout)><marker - * + or 1. / 1)> [status] rest
const TASK_LINE_RE = /^([\s\t>]*)((?:[-*+]|[0-9]+[.)])) +\[(.)\] *(.*)$/;
// End-anchored field matchers (symbol + optional VS16 + value at line end).
function taskFieldRe(symbol, value) {
  return new RegExp(symbol + "\\uFE0F? *" + value + "$");
}
const TASK_FIELD_RES = {
  priority: /(?:🔺|⏫|🔼|🔽|⏬)️? *$/,
  cancelledDate: taskFieldRe("❌", "(\\d{4}-\\d{2}-\\d{2})"),
  doneDate: taskFieldRe("✅", "(\\d{4}-\\d{2}-\\d{2})"),
  dueDate: taskFieldRe("(?:📅|📆|🗓)", "(\\d{4}-\\d{2}-\\d{2})"),
  scheduledDate: taskFieldRe("(?:⏳|⌛)", "(\\d{4}-\\d{2}-\\d{2})"),
  startDate: taskFieldRe("🛫", "(\\d{4}-\\d{2}-\\d{2})"),
  createdDate: taskFieldRe("➕", "(\\d{4}-\\d{2}-\\d{2})"),
};
const TASK_PRIORITIES = [
  ["", "none"],
  ["🔺", "highest"],
  ["⏫", "high"],
  ["🔼", "medium"],
  ["🔽", "low"],
  ["⏬", "lowest"],
];
// A leading pictographic cluster (no letters/digits) acts as the task icon.
const TASK_ICON_RE =
  /^(\p{Extended_Pictographic}(\p{EMod}|️|‍\p{Extended_Pictographic})*)/u;

// Parse one raw line into a task (or null). Fields are stripped from the end
// in a loop (obsidian-tasks semantics, any order). As a FALLBACK, date fields
// are also recognised mid-line — the [] shortcut stamps ➕ before the cursor,
// so a freshly typed task reads "➕ date description" until first rewritten;
// serialisation always normalises back to the canonical trailing order.
const TASK_FIELD_GLOBAL_RES = {
  cancelledDate: /❌️? *(\d{4}-\d{2}-\d{2})/g,
  doneDate: /✅️? *(\d{4}-\d{2}-\d{2})/g,
  dueDate: /(?:📅|📆|🗓)️? *(\d{4}-\d{2}-\d{2})/g,
  scheduledDate: /(?:⏳|⌛)️? *(\d{4}-\d{2}-\d{2})/g,
  startDate: /🛫️? *(\d{4}-\d{2}-\d{2})/g,
  createdDate: /➕️? *(\d{4}-\d{2}-\d{2})/g,
};
function parseTaskLine(raw) {
  const m = String(raw || "").match(TASK_LINE_RE);
  if (!m) return null;
  let body = m[4].trim();
  if (body === "") return null;
  const fields = {};
  let runs = 0;
  let stripped = true;
  while (stripped && runs++ < 20) {
    stripped = false;
    for (const key of Object.keys(TASK_FIELD_RES)) {
      const re = TASK_FIELD_RES[key];
      const hit = body.match(re);
      if (!hit) continue;
      fields[key] = key === "priority" ? hit[0].trim() : hit[1];
      body = body.replace(re, "").trim();
      stripped = true;
    }
  }
  for (const key of Object.keys(TASK_FIELD_GLOBAL_RES)) {
    if (fields[key] !== undefined) continue;
    const g = TASK_FIELD_GLOBAL_RES[key];
    g.lastIndex = 0; // shared /g regex — always start over
    const hit = g.exec(body);
    if (hit) {
      fields[key] = hit[1];
      body = body.replace(new RegExp(g.source), "").trim();
    }
  }
  const iconM = body.match(TASK_ICON_RE);
  const icon = iconM ? iconM[1] : "";
  const description = icon ? body.slice(icon.length).trim() : body;
  const statusChar = m[3];
  const status =
    statusChar === "-" ? "cancelled" : statusChar === " " ? "todo" : "done";
  return {
    raw: String(raw),
    line: null, // filled by the scanner
    indent: m[1],
    marker: m[2],
    statusChar,
    status, // todo | done | cancelled
    text: m[4].trim(), // full description INCLUDING inline fields (rendered text)
    body, // description incl. icon, fields stripped
    description, // description without the leading icon
    icon,
    priority: fields.priority || "",
    createdDate: fields.createdDate || "",
    doneDate: fields.doneDate || "",
    cancelledDate: fields.cancelledDate || "",
    dueDate: fields.dueDate || "",
    scheduledDate: fields.scheduledDate || "",
    startDate: fields.startDate || "",
  };
}
function todayStr() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
// Serialize back to a full task line; fields go on in canonical order (any
// order parses — this just keeps files tidy).
function serializeTaskLine(t) {
  const statusChar = t.status === "cancelled" ? "-" : t.status === "done" ? "x" : " ";
  let out =
    (t.indent || "") +
    (t.marker || "-") +
    " [" +
    statusChar +
    "] " +
    (t.icon ? t.icon + " " : "") +
    (t.description || "");
  const tail = [
    t.priority,
    t.startDate && "🛫 " + t.startDate,
    t.scheduledDate && "⏳ " + t.scheduledDate,
    t.dueDate && "📅 " + t.dueDate,
    t.createdDate && "➕ " + t.createdDate,
    t.status === "cancelled" && t.cancelledDate && "❌ " + t.cancelledDate,
    t.status === "done" && t.doneDate && "✅ " + t.doneDate,
  ].filter(Boolean);
  for (const piece of tail) out += " " + piece;
  return out;
}
// ---- v1.1.0: date fields hidden from RENDERING by default ---------------------
// The five bookkeeping stamps (➕ created ✅ done ❌ cancelled 🛫 start ⏳
// scheduled) trail every task line and clutter notes, so they are hidden at
// the DISPLAY layer only (settings toggle 任务行显示日期字段 / "Show task date
// fields", default off):
//   • reading view — the field text is wrapped in <span class="bn-task-dates">,
//     hidden by CSS unless body.bn-show-task-dates is present;
//   • live preview / source — a CodeMirror replace decoration per range; lines
//     the cursor touches stay raw, so editing always shows the full line;
//   • dashboard cards — the ➕/✅/❌ chips follow the same toggle.
// 📅 due and the priority stay visible everywhere (deadlines and urgency are
// content, not bookkeeping). The FILE text never changes and parsing,
// serialising, toggling and promoting all keep seeing the full raw line.
const TASK_DATE_HIDE_KEYS = [
  "cancelledDate",
  "doneDate",
  "scheduledDate",
  "startDate",
  "createdDate",
];
// Ranges of the hidden fields inside `text` — the RENDERED task text without
// the list marker (reading view) or the raw body. Same end-anchored strip
// loop as parseTaskLine (ALL field regexes strip — fields may sit beyond a
// due date or priority), but only the five hide-keys record spans. Spans
// separated by spaces-only gaps merge, each group swallows the spaces to its
// LEFT (never right — the surviving space keeps the visible parts apart),
// and the last group also swallows trailing spaces. Returns [{from,to}]
// ascending, offsets into `text`.
function taskDateHideRangesInText(text) {
  const s = String(text == null ? "" : text);
  if (!s.trim()) return [];
  const spans = [];
  let rest = s;
  let runs = 0;
  let stripped = true;
  while (stripped && runs++ < 20) {
    stripped = false;
    const trimmed = rest.replace(/[ \t]+$/, "");
    if (trimmed.length !== rest.length) {
      rest = trimmed;
      stripped = true;
    }
    for (const key of Object.keys(TASK_FIELD_RES)) {
      const hit = rest.match(TASK_FIELD_RES[key]);
      if (!hit) continue;
      const start = rest.length - hit[0].length;
      if (TASK_DATE_HIDE_KEYS.indexOf(key) !== -1) spans.push([start, rest.length]);
      rest = rest.slice(0, start);
      stripped = true;
    }
  }
  // fresh-task fallback: the [] shortcut stamps "➕ date " BEFORE the text
  // (mid-line until the first rewrite) — hide that leading stamp as well
  if (!spans.length) {
    const lead = s.match(/^➕️? *\d{4}-\d{2}-\d{2}(?:[ \t]+|$)/);
    if (lead) return [{ from: 0, to: lead[0].length }];
    return [];
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const sp of spans) {
    const prev = merged[merged.length - 1];
    const gap = prev ? s.slice(prev[1], sp[0]) : "";
    if (prev && /^[ \t]*$/.test(gap)) prev[1] = sp[1];
    else merged.push([sp[0], sp[1]]);
  }
  const out = [];
  for (let i = 0; i < merged.length; i++) {
    let from = merged[i][0];
    const floor = i > 0 ? merged[i - 1][1] : 0;
    while (from > floor && (s[from - 1] === " " || s[from - 1] === "\t")) from--;
    let to = merged[i][1];
    // trailing spaces only — never the separator space before a VISIBLE
    // field (due/priority) that follows this group
    if (i === merged.length - 1 && /^[ \t]*$/.test(s.slice(to))) to = s.length;
    out.push({ from, to });
  }
  return out;
}
// Absolute ranges within the RAW line (marker/indent included) — the input
// for editor decorations. [] for non-task lines and tasks without hidden
// fields.
function taskDateHideRanges(rawLine) {
  const raw = String(rawLine == null ? "" : rawLine);
  const m = raw.match(TASK_LINE_RE);
  if (!m) return [];
  if (!m[4].trim()) return [];
  // the match is ^-anchored and m[4] runs to the end, so its offset is exact
  const bodyStart = raw.length - m[4].length;
  return taskDateHideRangesInText(m[4]).map((r) => ({
    from: bodyStart + r.from,
    to: bodyStart + r.to,
  }));
}
// Reading view: wrap each hidden range's text nodes in
// <span class="bn-task-dates"> (hidden via CSS, shown by the body class the
// toggle sets). The text STAYS in the DOM, so matchReadingTask's
// textContent matching and the checkbox/promote wiring are unaffected.
// Nested lists are skipped — every task li wraps itself on its own pass.
// Vanilla DOM only (works in hover previews, embeds and popout windows).
function bnWrapReadingTaskDates(li) {
  try {
    if (!li || li.__bnDatesWrapped) return;
    li.__bnDatesWrapped = true;
    const nodes = [];
    const walk = (n) => {
      for (const c of Array.prototype.slice.call(n.childNodes)) {
        if (c.nodeType === 3) {
          nodes.push(c);
          continue;
        }
        if (c.nodeType !== 1) continue;
        const name = c.nodeName;
        if (name === "UL" || name === "OL") continue;
        if (c.classList && c.classList.contains("bn-task-btn")) continue;
        walk(c);
      }
    };
    walk(li);
    if (!nodes.length) return;
    let text = "";
    const offs = [];
    for (const n of nodes) {
      offs.push(text.length);
      text += n.nodeValue || "";
    }
    const ranges = taskDateHideRangesInText(text);
    for (let i = ranges.length - 1; i >= 0; i--) {
      const r = ranges[i];
      for (let j = nodes.length - 1; j >= 0; j--) {
        const s0 = offs[j];
        const e0 = s0 + (nodes[j].nodeValue || "").length;
        if (e0 <= r.from || s0 >= r.to) continue;
        const node = nodes[j];
        const a = Math.max(r.from, s0);
        const b = Math.min(r.to, e0);
        const doc = li.ownerDocument || document;
        const span = doc.createElement("span");
        span.className = "bn-task-dates";
        let piece = node;
        if (a > s0) piece = node.splitText(a - s0);
        if (b - a < (piece.nodeValue || "").length) piece.splitText(b - a);
        node.parentNode.insertBefore(span, piece);
        span.appendChild(piece);
      }
    }
  } catch (e) {
    /* never break reading-view rendering */
  }
}
// Live preview / source: replace-decorate the hidden ranges so the raw text
// simply is not rendered. Lines the selection touches are left alone — the
// full line shows while the cursor is on it (obsidian-tasks' reveal-on-edit
// behaviour), which also keeps the [] shortcut (cursor lands right after the
// stamped ➕ date) fully visible while typing. Guarded by the module-level
// CM6_VIEW probe: no @codemirror/view → [] (a valid empty extension).
function bnTaskDateEditorExtension(plugin) {
  if (!CM6_VIEW || !CM6_VIEW.ViewPlugin || !CM6_VIEW.Decoration) return [];
  const ViewPlugin = CM6_VIEW.ViewPlugin;
  const Decoration = CM6_VIEW.Decoration;
  const build = (view) => {
    try {
      const out = [];
      if (
        !plugin.alive ||
        !plugin.settings ||
        !plugin.settings.enableTasks ||
        plugin.settings.showTaskDates
      ) {
        return Decoration.set(out, true);
      }
      const state = view.state;
      if (!state || !state.doc || !state.selection) return Decoration.set(out, true);
      const sel = state.selection.ranges || [];
      for (const block of view.viewport || []) {
        for (let pos = block.from; pos <= block.to; ) {
          const line = state.doc.lineAt(pos);
          const next = line.to + 1;
          if (next <= pos) break; // never stall on a degenerate viewport edge
          pos = next;
          let touched = false;
          for (let i = 0; i < sel.length; i++) {
            if (sel[i].from <= line.to + 1 && sel[i].to >= line.from) {
              touched = true;
              break;
            }
          }
          if (touched) continue;
          for (const rg of taskDateHideRanges(line.text)) {
            out.push(Decoration.replace(line.from + rg.from, line.from + rg.to));
          }
        }
      }
      return Decoration.set(out, true);
    } catch (e) {
      try {
        return Decoration.set([], true);
      } catch (e2) {
        /* unreachable — keep the view alive no matter what */
      }
    }
  };
  const Holder = function (view) {
    this.decorations = build(view);
  };
  return ViewPlugin.fromClass(Holder, {
    decorations: (v) => v.decorations,
    update: (v, vu) => {
      v.decorations = build(vu.view);
    },
    destroy: () => {},
  });
}
// Collect one document's tasks; lines inside fenced code blocks are skipped.
function scanTasks(content) {
  const out = [];
  let fence = false;
  const lines = String(content || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const task = parseTaskLine(line);
    if (task) {
      task.line = i;
      out.push(task);
    }
  }
  return out;
}
// Strip a wikilink/markdown link to its display text.
function taskPlainName(text) {
  return String(text || "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, function (_, target, display) {
      return display || target;
    })
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~#]+/g, "")
    .trim();
}
// v2.1.0: a promoted task starts with a document link in EITHER style the
// vault generates — "[[target|display]] rest" or "[display](target.md) rest".
// Pure parsing, no vault access.
var TASK_WIKI_RE = /^\[\[([^\]]+)\]\]/;
var TASK_MD_RE = /^\[([^\]]*)\]\(([^)]*)\)/;
function parseTaskLink(text) {
  const s = String(text || "");
  var m = s.match(TASK_WIKI_RE);
  if (m) {
    var body = m[1];
    var pipe = body.indexOf("|");
    var target = (pipe === -1 ? body : body.slice(0, pipe)).trim();
    var display = pipe === -1 ? "" : body.slice(pipe + 1).trim();
    return {
      target: target,
      display: display || target.split("#")[0].trim() || target,
      rest: s.slice(m[0].length).trim(),
      kind: "wiki",
    };
  }
  var mm = s.match(TASK_MD_RE);
  if (mm) {
    var raw = mm[2].trim();
    var titled = raw.match(/^(\S+)(?:\s+["'][^"']*["'])?$/);
    var href = titled ? titled[1] : raw;
    // external links are not sub-page links — keep the task a plain one
    if (/^(https?|obsidian|file):/i.test(href)) return null;
    return {
      target: href,
      display: mm[1].trim() || href,
      rest: s.slice(mm[0].length).trim(),
      kind: "md",
    };
  }
  return null;
}

// ---- the task view NOTE (v2.2.0, pinch-style multi-view) --------------------
// "任务视图.md" holds one ```bn-tasks-view``` fenced block; the processor
// renders an interactive dashboard with three views (工作台 / 看板 / 四象限),
// working in BOTH reading and live preview. Task data comes from the shared
// engine; edits write back into the source notes (inline emoji fields).
// v2.5.0: the active tab persists in the host settings slot; kanban columns
// sort on header click; compact cards keep chips on the title line.
const TASK_VIEW_NOTE = "任务视图.md";
const TASK_VIEW_TABS = [
  ["bench", "工作台", "gauge"],
  ["kanban", "看板", "kanban"],
  ["matrix", "四象限", "layout-grid"],
];
// importance axis: medium priority and up counts as important
const IMPORTANT_PRIORITIES = ["🔺", "⏫", "🔼"];
const PRIORITY_WEIGHT = { "🔺": 5, "⏫": 4, "🔼": 3, "🔽": 2, "⏬": 1, "": 0 };
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const t = new Date(dateStr + "T00:00:00");
  if (isNaN(t.getTime())) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((t.getTime() - now.getTime()) / 86400000);
}
function taskIsUrgent(task) {
  const d = daysUntil(task.dueDate);
  return d !== null && d <= 1; // due today/tomorrow or overdue
}
function taskIsImportant(task) {
  return IMPORTANT_PRIORITIES.includes(task.priority);
}
function quadrantOf(task) {
  const imp = taskIsImportant(task);
  const urg = taskIsUrgent(task);
  return urg && imp ? 0 : imp ? 1 : urg ? 2 : 3; // Q1..Q4
}
// Kanban in-column sort modes (header click cycles them).
const KANBAN_SORTS = ["default", "due", "priority", "created"];
function sortTaskItems(items, mode) {
  const list = items.slice();
  if (mode === "due")
    list.sort((a, b) => {
      const ad = a.task.dueDate || "9999";
      const bd = b.task.dueDate || "9999";
      return ad === bd ? 0 : ad < bd ? -1 : 1;
    });
  else if (mode === "priority")
    list.sort(
      (a, b) =>
        (PRIORITY_WEIGHT[b.task.priority] || 0) - (PRIORITY_WEIGHT[a.task.priority] || 0)
    );
  else if (mode === "created")
    list.sort((a, b) => {
      const ac = a.task.createdDate || "";
      const bc = b.task.createdDate || "";
      return ac === bc ? 0 : ac > bc ? -1 : 1;
    });
  return list;
}
// done counts for each of the last `n` days (oldest first) for the trend bar
function weekDoneCounts(items, n = 7) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const p = (x) => (x < 10 ? "0" : "") + x;
    const key = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
    out.push({
      key,
      count: items.filter((it) => it.task.doneDate === key || it.task.cancelledDate === key)
        .length,
    });
  }
  return out;
}
// ---- shared card rendering ---------------------------------------------------
function renderTaskCard(plugin, parent, item, opts) {
  const t = item.task;
  const card = parent.createDiv({
    cls: "bn-tv-card" + (t.status !== "todo" ? " is-done" : ""),
  });
  if (opts && opts.draggable) {
    card.draggable = true;
    card.addEventListener("dragstart", (ev) => {
      plugin.__tvDrag = { file: item.file, task: t };
      try {
        ev.dataTransfer?.setData("text/plain", t.description);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      } catch (e) {
        /* decorative */
      }
      card.addClass("is-dragging");
    });
    card.addEventListener("dragend", () => {
      card.removeClass("is-dragging");
      plugin.__tvDrag = null;
    });
  }
  // one wrapping line: [checkbox][icon][label][chips] — short tasks stay a
  // single compact row, long labels wrap and the chips flow after them
  const head = card.createDiv({ cls: "bn-tv-card-head" });
  const check = head.createEl("input", { type: "checkbox", cls: "bn-task-check" });
  check.checked = t.status !== "todo";
  check.addEventListener("click", (ev) => ev.stopPropagation());
  check.addEventListener("change", () => void plugin.toggleTask(item.file, t));
  if (t.icon) head.createSpan({ cls: "bn-tv-card-icon", text: t.icon });
  const label = head.createDiv({ cls: "bn-tv-card-label" });
  const link = parseTaskLink(t.description);
  if (link) {
    const a = label.createEl("a", {
      cls: "internal-link",
      text: link.display,
      href: link.target,
    });
    a.setAttribute("data-href", link.target);
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const target = plugin.taskLinkFile(t.description, item.file.path);
      if (target) void plugin.openMarkdown(target.path);
      else void plugin.app.workspace.openLinkText(link.target.split("#")[0], item.file.path);
    });
    if (link.rest) label.createSpan({ cls: "bn-task-rest", text: " " + link.rest });
  } else {
    label.setText(t.description);
  }
  const meta = head.createDiv({ cls: "bn-tv-card-meta" });
  const chip = (icon, text, cls) => {
    const c = meta.createSpan({ cls: "bn-task-chip" + (cls ? " " + cls : "") });
    c.createSpan({ cls: "bn-task-chip-icon", text: icon });
    if (text) c.createSpan({ cls: "bn-task-chip-text", text: text });
  };
  if (t.priority) chip(t.priority, "", "bn-task-chip-prio");
  if (t.dueDate) chip("📅", t.dueDate, daysUntil(t.dueDate) < 0 ? "bn-task-chip-overdue" : "");
  // v1.1.0: the bookkeeping stamps follow the "Show task date fields" toggle
  // (due + priority above always show — they carry meaning, not timestamps)
  const showDates = plugin.settings.showTaskDates === true;
  if (showDates && t.createdDate) chip("➕", t.createdDate);
  if (showDates && t.doneDate) chip("✅", t.doneDate, "bn-task-chip-done");
  if (showDates && t.cancelledDate) chip("❌", t.cancelledDate, "bn-task-chip-done");
  const src = meta.createSpan({
    cls: "bn-task-chip bn-task-chip-src",
    attr: { title: item.file.path },
  });
  src.createSpan({ cls: "bn-task-chip-text", text: item.file.basename || item.file.path });
  // click anywhere (except the checkbox/links) → edit modal
  card.addEventListener("click", (ev) => {
    if (ev.target instanceof Element && ev.target.closest("input, a")) return;
    plugin.openTaskEditModal(item.file, t);
  });
  return card;
}
// ---- the block renderer --------------------------------------------------------
function renderTasksViewBlock(plugin, el, source) {
  const zh = plugin.isZh();
  el.addClass("bn-tv");
  let tab = plugin.settings.taskViewTab || "bench";
  for (const line of String(source || "").split("\n")) {
    const s = line.trim().toLowerCase();
    if (s === "看板" || s === "kanban") tab = "kanban";
    else if (s === "四象限" || s === "matrix" || s === "quadrant") tab = "matrix";
    else if (s === "工作台" || s === "bench" || s === "dashboard") tab = "bench";
  }
  const items = plugin.allTasks();
  const todo = items.filter((i) => i.task.status === "todo");
  const done = items.filter((i) => i.task.status !== "todo");
  // ---- tab bar ----
  const bar = el.createDiv({ cls: "bn-tv-tabs" });
  for (const [key, label, icon] of TASK_VIEW_TABS) {
    const b = bar.createEl("button", {
      cls: "bn-tv-tab" + (tab === key ? " is-active" : ""),
    });
    try {
      (0, obsidian.setIcon)(b, icon);
    } catch (e) {
      /* decorative */
    }
    b.createSpan({ text: label });
    b.addEventListener("click", () => {
      plugin.settings.taskViewTab = key;
      void plugin.saveSettings();
      el.empty();
      renderTasksViewBlock(plugin, el, source);
    });
  }
  const refreshBtn = bar.createEl("button", { cls: "bn-tv-refresh clickable-icon" });
  refreshBtn.setAttribute("aria-label", zh ? "刷新" : "Refresh");
  try {
    (0, obsidian.setIcon)(refreshBtn, "refresh-cw");
  } catch (e) {
    /* decorative */
  }
  refreshBtn.addEventListener("click", () => {
    void plugin.__taskIndexAll();
  });
  const body = el.createDiv({ cls: "bn-tv-body" });
  if (tab === "kanban") renderKanban(plugin, body, items, el, source);
  else if (tab === "matrix") renderMatrix(plugin, body, items);
  else renderBench(plugin, body, items, todo, done);
}
// ---- 工作台 ---------------------------------------------------------------------
function renderBench(plugin, body, items, todo, done) {
  const zh = plugin.isZh();
  const today = todayStr();
  const dueToday = todo.filter((i) => i.task.dueDate === today);
  const overdue = todo.filter((i) => {
    const d = daysUntil(i.task.dueDate);
    return d !== null && d < 0;
  });
  const important = todo.filter((i) => taskIsImportant(i.task));
  const doneToday = done.filter(
    (i) => i.task.doneDate === today || i.task.cancelledDate === today
  );
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const doneWeek = done.filter((i) => (i.task.doneDate || "") >= weekAgo);
  const cards = body.createDiv({ cls: "bn-tv-stats" });
  const stat = (n, label, cls) => {
    const c = cards.createDiv({ cls: "bn-tv-stat" + (cls ? " " + cls : "") });
    c.createDiv({ cls: "bn-tv-stat-n", text: String(n) });
    c.createDiv({ cls: "bn-tv-stat-label", text: label });
  };
  stat(todo.length, zh ? "待办" : "Open");
  stat(dueToday.length, zh ? "今日到期" : "Due today");
  stat(overdue.length, zh ? "已逾期" : "Overdue", overdue.length ? "is-warn" : "");
  stat(important.length, zh ? "重要" : "Important");
  stat(doneToday.length, zh ? "今日完成" : "Done today");
  stat(doneWeek.length, zh ? "本周完成" : "This week");
  // 近 7 日完成趋势
  const week = weekDoneCounts(items, 7);
  const trendBox = body.createDiv({ cls: "bn-tv-panel" });
  trendBox.createDiv({
    cls: "bn-tv-panel-title",
    text: (zh ? "近 7 日完成" : "Last 7 days") + " · " + week.reduce((s, d) => s + d.count, 0),
  });
  const trend = trendBox.createDiv({ cls: "bn-tv-trend" });
  for (const day of week) {
    const bar = trend.createDiv({
      cls: "bn-tv-trend-day",
      attr: { title: day.key + " · " + day.count },
    });
    bar.createDiv({ cls: "bn-tv-trend-bar" }).style.height =
      Math.max(4, Math.round((day.count / Math.max(1, ...week.map((w) => w.count))) * 36)) + "px";
    bar.createDiv({ cls: "bn-tv-trend-label", text: day.key.slice(5).replace("-", "/") });
  }
  // 今日聚焦: overdue + due today
  const focus = [...overdue, ...dueToday].slice(0, 12);
  const focusBox = body.createDiv({ cls: "bn-tv-panel" });
  focusBox.createDiv({
    cls: "bn-tv-panel-title",
    text: (zh ? "今日聚焦" : "Today's focus") + " · " + focus.length,
  });
  if (!focus.length)
    focusBox.createDiv({
      cls: "bn-tv-empty",
      text: zh ? "没有到期或逾期的任务 🎉" : "Nothing due or overdue 🎉",
    });
  for (const item of focus) renderTaskCard(plugin, focusBox, item, {});
  // 最近完成
  const recent = done
    .filter((i) => i.task.doneDate)
    .sort((a, b) => (a.task.doneDate < b.task.doneDate ? 1 : -1))
    .slice(0, 6);
  if (recent.length) {
    const rBox = body.createDiv({ cls: "bn-tv-panel" });
    rBox.createDiv({ cls: "bn-tv-panel-title", text: zh ? "最近完成" : "Recently done" });
    for (const item of recent) renderTaskCard(plugin, rBox, item, {});
  }
}
// ---- 看板 -----------------------------------------------------------------------
function renderKanban(plugin, body, items, el, source) {
  const zh = plugin.isZh();
  const sort = KANBAN_SORTS.includes(plugin.__tvKanbanSort)
    ? plugin.__tvKanbanSort
    : "default";
  const sortLabels = {
    default: zh ? "默认" : "Default",
    due: zh ? "按截止" : "By due",
    priority: zh ? "按优先级" : "By priority",
    created: zh ? "按创建" : "By created",
  };
  const sortIcons = { default: "arrow-up-narrow-wide", due: "calendar-clock", priority: "flag", created: "calendar-plus" };
  const columns = [
    ["todo", zh ? "待办" : "Todo", "circle-dashed"],
    ["done", zh ? "已完成" : "Done", "check-circle-2"],
    ["cancelled", zh ? "已取消" : "Cancelled", "x-circle"],
  ];
  const board = body.createDiv({ cls: "bn-tv-kanban" });
  for (const [status, label, icon] of columns) {
    const col = board.createDiv({ cls: "bn-tv-col" });
    col.addEventListener("dragover", (ev) => {
      if (!plugin.__tvDrag) return;
      ev.preventDefault();
      col.addClass("is-over");
    });
    col.addEventListener("dragleave", () => col.removeClass("is-over"));
    col.addEventListener("drop", (ev) => {
      ev.preventDefault();
      col.removeClass("is-over");
      const drag = plugin.__tvDrag;
      plugin.__tvDrag = null;
      if (drag && drag.task.status !== status)
        void plugin.setTaskStatus(drag.file, drag.task, status);
    });
    const list = sortTaskItems(
      items.filter((i) => i.task.status === status),
      sort
    );
    const head = col.createDiv({ cls: "bn-tv-col-head" });
    const hIcon = head.createSpan({ cls: "bn-tv-col-icon" });
    try {
      (0, obsidian.setIcon)(hIcon, icon);
    } catch (e) {
      /* decorative */
    }
    head.createSpan({ cls: "bn-tv-col-title", text: label });
    head.createSpan({ cls: "bn-tv-col-count", text: String(list.length) });
    // header click cycles the in-column sort
    const sortBtn = head.createEl("button", { cls: "bn-tv-sort clickable-icon" });
    sortBtn.setAttribute("aria-label", zh ? "切换排序:" + sortLabels[sort] : "Sort: " + sortLabels[sort]);
    sortBtn.setAttribute("title", sortLabels[sort]);
    try {
      (0, obsidian.setIcon)(sortBtn, sortIcons[sort]);
    } catch (e) {
      /* decorative */
    }
    sortBtn.addEventListener("click", () => {
      const at = KANBAN_SORTS.indexOf(plugin.__tvKanbanSort || "default");
      plugin.__tvKanbanSort = KANBAN_SORTS[(at + 1) % KANBAN_SORTS.length];
      plugin.refreshTaskViews();
    });
    const cards = col.createDiv({ cls: "bn-tv-col-cards" });
    if (!list.length)
      cards.createDiv({
        cls: "bn-tv-empty",
        text: zh ? "拖动卡片到这里" : "Drag cards here",
      });
    for (const item of list) renderTaskCard(plugin, cards, item, { draggable: true });
  }
}
// ---- 四象限 ---------------------------------------------------------------------
function renderMatrix(plugin, body, items) {
  const zh = plugin.isZh();
  const quads = [
    [0, zh ? "🔴 重要 · 紧急" : "🔴 Urgent + Important", zh ? "立即做" : "Do now"],
    [1, zh ? "🟠 重要 · 不紧急" : "🟠 Important, not urgent", zh ? "计划做" : "Schedule"],
    [2, zh ? "🟡 紧急 · 不重要" : "🟡 Urgent, not important", zh ? "尽快委托/简化" : "Delegate"],
    [3, zh ? "⚪ 不重要 · 不紧急" : "⚪ Neither", zh ? "稍后再说" : "Later"],
  ];
  const grid = body.createDiv({ cls: "bn-tv-matrix" });
  const todo = items.filter((i) => i.task.status === "todo");
  for (const [q, title, hint] of quads) {
    const cell = grid.createDiv({ cls: "bn-tv-quad bn-tv-quad-" + q });
    // drop target: adjust the two axes the quadrant stands for
    cell.addEventListener("dragover", (ev) => {
      if (!plugin.__tvDrag) return;
      ev.preventDefault();
      cell.addClass("is-over");
    });
    cell.addEventListener("dragleave", () => cell.removeClass("is-over"));
    cell.addEventListener("drop", (ev) => {
      ev.preventDefault();
      cell.removeClass("is-over");
      const drag = plugin.__tvDrag;
      plugin.__tvDrag = null;
      if (drag) void plugin.setTaskQuadrant(drag.file, drag.task, q);
    });
    const head = cell.createDiv({ cls: "bn-tv-quad-head" });
    head.createSpan({ cls: "bn-tv-quad-title", text: title });
    head.createSpan({ cls: "bn-tv-quad-hint", text: hint });
    const list = todo.filter((i) => quadrantOf(i.task) === q);
    head.createSpan({ cls: "bn-tv-col-count", text: String(list.length) });
    const cards = cell.createDiv({ cls: "bn-tv-quad-cards" });
    if (!list.length)
      cards.createDiv({ cls: "bn-tv-empty", text: zh ? "拖到这里" : "Drag here" });
    for (const item of list) renderTaskCard(plugin, cards, item, { draggable: true });
  }
}

// The task editing modal (obsidian-tasks style): description, status, icon,
// dates, priority. Saving rewrites the single task line inline.
// (Reinstated in v2.2.1 — it was accidentally dropped with the old sidebar
// view file in v2.2.0.)
var TaskEditModal = class extends obsidian.Modal {
  constructor(app, plugin, file, task) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.task = task;
    this.draftIcon = task.icon || "";
  }
  onOpen() {
    var zh = this.plugin.isZh();
    this.setTitle(zh ? "编辑任务" : "Edit task");
    this.modalEl.addClass("bn-task-modal");
    var t = this.task;
    var fields = { description: t.description, status: t.status, priority: t.priority || "" };
    // v2.4.0: date fields use a native <input type="date"> calendar dropdown
    // instead of a bare YYYY-MM-DD text field; v2.5.0: two-column grid;
    // v2.5.1: the extra clear button is gone — it crowded the control and
    // made rows wrap (clearing a date: focus the field, delete the text)
    var dateGrid = this.contentEl.createDiv({ cls: "bn-task-modal-dates" });
    var bindDate = (key) => {
      var setting = new obsidian.Setting(dateGrid).setName(key.label);
      var input = setting.controlEl.createEl("input", {
        type: "date",
        cls: "bn-task-date-input",
      });
      input.value = t[key.name] || "";
      input.addEventListener("change", function () {
        fields[key.name] = input.value || "";
      });
    };
    new obsidian.Setting(this.contentEl)
      .setName(zh ? "描述" : "Description")
      .addTextArea((area) => {
        area.setValue(t.description).onChange((v) => (fields.description = v));
        if (area.inputEl) area.inputEl.rows = 2;
      });
    new obsidian.Setting(this.contentEl)
      .setName(zh ? "状态" : "Status")
      .addDropdown((drop) => {
        drop
          .addOption("todo", zh ? "待办" : "Todo")
          .addOption("done", zh ? "已完成" : "Done")
          .addOption("cancelled", zh ? "已取消" : "Cancelled")
          .setValue(t.status)
          .onChange((v) => (fields.status = v));
      });
    var iconSetting = new obsidian.Setting(this.contentEl).setName(
      zh ? "图标(行首表情)" : "Icon (leading emoji)"
    );
    iconSetting.setDesc(
      zh
        ? "图标以表情形式写在任务描述行首——所有编辑器可见,随库同步。"
        : "The icon is an emoji at the start of the task text — visible in every editor, synced with the vault."
    );
    var modal = this;
    iconSetting.addButton((btn) => {
      var paint = () => btn.setButtonText(modal.draftIcon || (zh ? "选择…" : "Pick…"));
      paint();
      btn.onClick(() => {
        modal.plugin.openEmojiPicker({
          current: () => modal.draftIcon,
          pick: (emoji) => {
            modal.draftIcon = emoji || "";
            paint();
          },
        });
      });
    });
    bindDate({ name: "createdDate", label: zh ? "➕ 创建日期" : "➕ Created" });
    bindDate({ name: "startDate", label: zh ? "🛫 开始日期" : "🛫 Start" });
    bindDate({ name: "scheduledDate", label: zh ? "⏳ 计划日期" : "⏳ Scheduled" });
    bindDate({ name: "dueDate", label: zh ? "📅 截止日期" : "📅 Due" });
    // v2.3.1: no priority dropdown here — priority is managed by DRAGGING the
    // card across matrix quadrants (⏫ on the important side, cleared off it);
    // finer levels (🔺🔼🔽⏬) stay editable as plain text in the task line.
    var saveSetting = new obsidian.Setting(this.contentEl);
    saveSetting.addButton((btn) =>
      btn
        .setButtonText(zh ? "保存" : "Save")
        .setCta()
        .onClick(() => {
          var next = Object.assign({}, t, fields, { icon: this.draftIcon });
          if (next.status === "done" && !next.doneDate) next.doneDate = todayStr();
          if (next.status !== "done") next.doneDate = "";
          if (next.status === "cancelled" && !next.cancelledDate) next.cancelledDate = todayStr();
          if (next.status !== "cancelled") next.cancelledDate = "";
          void this.plugin.replaceTaskLine(this.file, t.raw, serializeTaskLine(next));
          this.close();
        })
    );
    saveSetting.addButton((btn) =>
      btn.setButtonText(zh ? "取消" : "Cancel").onClick(() => this.close())
    );
    // v2.5.0: delete the task line straight from the modal
    saveSetting.addButton((btn) =>
      btn
        .setButtonText(zh ? "删除任务" : "Delete task")
        .setWarning()
        .onClick(() => {
          void this.plugin.deleteTaskLine(this.file, t.raw);
          this.close();
        })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
};

// ---- v1.2.0: breadcrumb hover → child notes menu --------------------------------
// Obsidian (≥1.7) renders the note's parent path in the view header as
// span.view-header-breadcrumb segments ("工作 / 项目 / …"), each followed by a
// "/" separator span; a native CLICK only reveals the folder in the SYSTEM
// file manager (showItemInFolder — verified against obsidian.asar 1.14.5).
// This adds Notion-style navigation: hovering a segment pops that folder's
// child notes (plugin order + hide rules honoured, home notes excluded) and
// a click opens the child — folders via openFolder (their home note), files
// directly. The path needs NO view lookup: the segment texts of one header,
// joined up to the hovered index, ARE the folder path (they were built from
// the parent path's components).
// The hovered segment → folder path (or null when the DOM is unexpected).
function bnCrumbPathOf(seg) {
  try {
    const parent = seg.parentElement;
    if (!parent || typeof parent.children === "undefined") return null;
    const segs = [];
    for (const c of parent.children) {
      if (c.nodeType === 1 && c.classList && c.classList.contains("view-header-breadcrumb")) {
        segs.push(c);
      }
    }
    const idx = segs.indexOf(seg);
    if (idx === -1) return null;
    const names = [];
    for (let i = 0; i <= idx; i++) names.push(String(segs[i].textContent || "").trim());
    if (!names.length) return null;
    for (const n of names) if (!n || n.indexOf("/") !== -1) return null;
    return names.join("/");
  } catch (e) {
    return null;
  }
}
// Fill the menu: header count + one bn-child-row per child (renderChildRow
// carries icon + click-to-open, ctrl/cmd = new tab). Empty folders get a
// hint row instead. Returns the child count.
function bnRenderCrumbMenu(plugin, menu, folderPath) {
  const zh = plugin.isZh();
  const kids = plugin.orderedChildrenOf(folderPath);
  menu.createDiv({
    cls: "bn-children-header",
    text: (zh ? "子页面" : "Child notes") + " · " + kids.length,
  });
  if (!kids.length) {
    menu.createDiv({ cls: "bn-crumb-empty", text: zh ? "暂无子文档" : "No child notes" });
    return 0;
  }
  for (const child of kids) plugin.renderChildRow(menu, child, { time: false }, 0);
  return kids.length;
}

// ---------------------------------------------------------------------------
// §7 the host plugin
// ---------------------------------------------------------------------------
const HOST_DEFAULTS = {
  childTemplatePath: "",
  homeTemplatePath: "",
  showCounts: true,
  showAliases: false,
  linkCreatesChild: true,
  breadcrumbChildren: true,
  dblClickExpand: true,
  enableHideItem: true,
  enableFavorites: true,
  enableRecent: true,
  enableTasks: true,
  autoIcon: true,
  taskViewTab: "bench",
  showTaskDates: false,
  enableViewMode: true,
  viewModeKey: "auto-view-mode",
  enableEmptyHomeDelete: true,
};
const boolSlot = (slot, key) =>
  typeof slot[key] === "boolean" ? slot[key] : HOST_DEFAULTS[key];
// Per-note view mode (v2.7.0): frontmatter value -> MarkdownView state patch.
// Built once at module level; the referenced plugin rebuilt this map on every call.
const VIEW_MODE_STATES = {
  preview: { mode: "preview" },
  reading: { mode: "preview" },
  edit: { mode: "source", source: false }, // live preview
  live: { mode: "source", source: false },
  source: { mode: "source", source: true },
};
function sanitizeTaskMeta(src) {
  const out = {};
  if (src && typeof src === "object") {
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (!v || typeof v !== "object") continue;
      const e = {};
      if (typeof v.icon === "string") e.icon = v.icon;
      if (typeof v.created === "number") e.created = v.created;
      if (typeof v.done === "number") e.done = v.done;
      out[k] = e;
    }
  }
  return out;
}

class BeautifySettingsTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    this.containerEl.empty();
    for (const def of this.plugin.hostSettingsDefs()) {
      if (def.heading) {
        this.containerEl.createEl("h3", { text: def.heading });
        continue;
      }
      if (def.subheading) {
        this.containerEl.createEl("div", { cls: "branch-order-subheading", text: def.subheading });
        continue;
      }
      const setting = new obsidian.Setting(this.containerEl);
      if (def.name) setting.setName(def.name);
      if (def.desc) setting.setDesc(def.desc);
      if (def.control) {
        // { type: "toggle", key } — bound to plugin.settings
        setting.addToggle((toggle) =>
          toggle
            .setValue(!!this.plugin.settings[def.control.key])
            .onChange((value) => {
              this.plugin.settings[def.control.key] = value;
              void this.plugin.saveSettings();
            })
        );
        continue;
      }
      if (typeof def.render === "function") def.render(setting);
    }
  }
  redraw() {
    if (this.containerEl) {
      try {
        this.display();
      } catch (e) {
        console.error("[beautify] failed to redraw settings:", e);
      }
    }
  }
}

const BeautifyPlugin = class extends obsidian.Plugin {
  constructor() {
    super(...arguments);
    // orchestration
    this.config = new ConfigNote(this);
    this.order = null; // OrderCore, set in onload
    this.settings = Object.assign({}, HOST_DEFAULTS);
    this.settingsTab = null;
    // absorbed Branch Note state
    this.language = "auto";
    this.drafts = Object.create(null);
    this.files = null;
    this.service = null;
    this.alive = false;
    this.__bnActive = false;
    this.views = new Map();
    this.delegatedViews = new Set();
    this.itemClicks = new Map();
    this.ownMoves = new Set();
    this.commandLabels = [];
    // host features
    this.childrenBlocks = new Map(); // block el -> folder path (or null)
    this.injectedTemplates = new Map(); // pristine template content by path
    this.__btnPath = new Map(); // hover "+" button el -> item path
    this.__countsDirty = true;
    this.__refreshTimer = null;
    this.collator = null;
    // task management
    this.taskViewBlocks = new Set();
    this.__taskIndex = new Map(); // file path -> task array
    this.__taskRefreshTimer = null;
    this.__taskFloat = null;
    this.__taskFloatView = null;
    this.__taskLastLineEl = null;
    // per-note view mode (v2.7.0)
    this.__viewModeApplied = new WeakMap(); // leaf -> last path handled
    this.__viewModePending = false; // a deferred re-scan is in flight (v2.8.2)
    this.__viewModeTimers = new Set(); // live timer ids, cleared on unload (v2.9.2)
    this.t = (key) =>
      translate(
        resolveLanguage(this.language, (0, obsidian.getLanguage)()),
        key
      );
  }

  // ---- namespaced storage / legacy import ----------------------------------
  async readSlot(key) {
    return this.config.readSlot(key);
  }
  writeSlot(key, value) {
    return this.config.writeSlot(key, value);
  }
  async readLegacyData(pluginId) {
    try {
      const dir = this.manifest.dir || "";
      const parentDir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
      const path = (0, obsidian.normalizePath)(
        (parentDir ? parentDir + "/" : "") + pluginId + "/data.json"
      );
      const adapter = this.app.vault.adapter;
      if (typeof adapter.exists !== "function" || !(await adapter.exists(path))) return null;
      const parsed = JSON.parse(await adapter.read(path));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      console.error("[beautify] could not read legacy plugin data for " + pluginId + ":", e);
      return null;
    }
  }

  // ---- host settings ---------------------------------------------------------
  async loadHostSettings() {
    const slot = await this.readSlot("host");
    const modes = {};
    if (slot.folderSortModes && typeof slot.folderSortModes === "object") {
      for (const k of Object.keys(slot.folderSortModes)) {
        const m = slot.folderSortModes[k];
        if (m === "name" || m === "mtime" || m === "ctime") modes[k] = m;
      }
    }
    // icons: import emoji icons from Iconic once, then trust our own copy.
    // v1.3.0: icons serialize inside the orderEditor TREE now — a host slot
    // without `icons` is the steady state, and the in-memory map (filled by
    // the store's tree parse) must SURVIVE this rebind; a flat `icons` map is
    // the legacy pre-v1.3.0 shape and still loads (it migrates into the tree
    // on the first v3 save).
    let icons = {};
    if (slot.icons && typeof slot.icons === "object") {
      for (const k of Object.keys(slot.icons)) {
        if (typeof slot.icons[k] === "string") icons[k] = slot.icons[k];
      }
    } else if (slot.iconsImported !== true) {
      icons = await this.importIconicIcons();
    } else {
      icons = Object.assign({}, this.settings.icons || {});
    }
    // hide rules: import from Hide Folders once
    let hideRules = Array.isArray(slot.hideRules)
      ? slot.hideRules.filter((x) => typeof x === "string")
      : [];
    let showHidden = slot.showHidden === true;
    if (slot.hideRules === undefined && slot.hideImported !== true) {
      const hf = await this.importHideFoldersRules();
      hideRules = hf.hideRules;
      if (typeof slot.showHidden !== "boolean") showHidden = hf.showHidden;
    }
    this.settings = {
      childTemplatePath:
        typeof slot.childTemplatePath === "string"
          ? slot.childTemplatePath
          : HOST_DEFAULTS.childTemplatePath,
      homeTemplatePath:
        typeof slot.homeTemplatePath === "string"
          ? slot.homeTemplatePath
          : HOST_DEFAULTS.homeTemplatePath,
      showCounts: typeof slot.showCounts === "boolean" ? slot.showCounts : HOST_DEFAULTS.showCounts,
      showAliases: boolSlot(slot, "showAliases"),
      linkCreatesChild: boolSlot(slot, "linkCreatesChild"),
      breadcrumbChildren: boolSlot(slot, "breadcrumbChildren"),
      dblClickExpand:
        typeof slot.dblClickExpand === "boolean"
          ? slot.dblClickExpand
          : typeof slot.expandOnOpen === "boolean" // pre-rename v2.6.0 key
            ? slot.expandOnOpen
            : HOST_DEFAULTS.dblClickExpand,
      enableHideItem: boolSlot(slot, "enableHideItem"),
      // v2.10.0: quick access split into favorites + recent, each with its own
      // toggle; a pre-split enableQuickAccess=false disables both (explicit
      // new keys win over the legacy one).
      enableFavorites:
        typeof slot.enableFavorites === "boolean"
          ? slot.enableFavorites
          : slot.enableQuickAccess === false
            ? false
            : HOST_DEFAULTS.enableFavorites,
      enableRecent:
        typeof slot.enableRecent === "boolean"
          ? slot.enableRecent
          : slot.enableQuickAccess === false
            ? false
            : HOST_DEFAULTS.enableRecent,
      enableTasks: boolSlot(slot, "enableTasks"),
      taskViewTab: ["bench", "kanban", "matrix"].includes(slot.taskViewTab)
        ? slot.taskViewTab
        : "bench",
      showTaskDates: boolSlot(slot, "showTaskDates"),
      taskMeta: sanitizeTaskMeta(slot.taskMeta),
      autoIcon: boolSlot(slot, "autoIcon"),
      enableViewMode: boolSlot(slot, "enableViewMode"),
      viewModeKey:
        typeof slot.viewModeKey === "string" && slot.viewModeKey.trim() !== ""
          ? slot.viewModeKey.trim()
          : HOST_DEFAULTS.viewModeKey,
      enableEmptyHomeDelete: boolSlot(slot, "enableEmptyHomeDelete"),
      favorites: Array.isArray(slot.favorites)
        ? slot.favorites.filter((x) => typeof x === "string")
        : [],
      folderSortModes: modes,
      icons,
      iconsImported: true,
      hideRules,
      hideImported: true,
      showHidden,
    };
    this.__lastShowHidden = showHidden;
    // v1.3.0: baseline for saveSettings' icons-changed detection
    this.__iconsJson = JSON.stringify(this.settings.icons || {});
  }
  async importIconicIcons() {
    const icons = {};
    try {
      const data = await this.readLegacyData("iconic");
      if (data && typeof data === "object") {
        const collect = (map) => {
          if (!map || typeof map !== "object") return;
          for (const path of Object.keys(map)) {
            const v = map[path];
            const icon =
              v && typeof v === "object" && typeof v.icon === "string"
                ? v.icon
                : typeof v === "string"
                  ? v
                  : null;
            // keep emoji only (lucide names can't render as text)
            if (icon && /[^\x00-\x7F]/.test(icon)) icons[path] = icon;
          }
        };
        collect(data.fileIcons);
        collect(data.folderIcons);
      }
    } catch (e) {
      console.error("[beautify] failed to import icons from Iconic:", e);
    }
    return icons;
  }
  async importHideFoldersRules() {
    const out = { hideRules: [], showHidden: false };
    try {
      const data = await this.readLegacyData("hide-folders");
      if (data && typeof data === "object") {
        const names = data.attachmentFolderNames;
        if (Array.isArray(names))
          out.hideRules = names.filter((x) => typeof x === "string" && x.trim() !== "");
        out.showHidden = data.areFoldersHidden === false;
      }
    } catch (e) {
      console.error("[beautify] failed to import rules from Hide Folders:", e);
    }
    return out;
  }
  async saveSettings() {
    const showHiddenChanged =
      this.__lastShowHidden !== undefined && this.__lastShowHidden !== this.settings.showHidden;
    // v1.3.0: icons serialize inside the orderEditor tree — strip them from
    // the host payload when the order store is alive (it owns the tree), and
    // reserialize the tree when they changed through this path (picker,
    // auto-icon, rename rekey). With the store down (order core failed to
    // start) the legacy flat host icons stay the fallback so nothing is lost.
    const storeAlive = !!(
      this.order &&
      this.order.store &&
      this.order.store.isUsable &&
      this.order.store.isUsable()
    );
    const payload =
      storeAlive && this.settings.icons
        ? Object.assign({}, this.settings, { icons: undefined })
        : this.settings;
    await this.writeSlot("host", payload);
    if (storeAlive) {
      const json = JSON.stringify(this.settings.icons || {});
      if (json !== this.__iconsJson) {
        this.__iconsJson = json;
        this.order.store.touchIcons();
      }
    }
    this.refreshCounts();
    if (showHiddenChanged) {
      this.refresh();
      this.refreshChildrenBlocks();
      this.updateRibbonIcon();
    }
    this.__lastShowHidden = this.settings.showHidden;
  }
  // ---- host path data: follow renames (v2.7.1) ---------------------------------
  // settings.icons / folderSortModes / taskMeta are keyed by vault path and
  // favorites / hideRules store paths — a rename must rekey all of them or
  // the data orphans silently (the order index already follows renames via
  // indexAfterFolderRename; the host slot had no equivalent).
  migrateHostPathsOnRename(file, oldPath) {
    if (!file || typeof file.path !== "string" || file.path === oldPath) return;
    this.__traceOpen?.("rename: " + oldPath + " → " + file.path);
    const __t = Date.now();
    const from = oldPath,
      to = file.path;
    const moved = (k) =>
      typeof k === "string"
        ? k === from
          ? to
          : k.startsWith(from + "/")
            ? to + k.slice(from.length)
            : null
        : null;
    let changed = false;
    for (const mapKey of ["icons", "folderSortModes", "taskMeta"]) {
      const map = this.settings[mapKey];
      if (!map || typeof map !== "object") continue;
      const updates = [];
      for (const k of Object.keys(map)) {
        let nk = moved(k);
        if (!nk && mapKey === "taskMeta") {
          // taskMeta keys are "path\u0001task text"
          const sep = k.indexOf("\u0001");
          if (sep !== -1) {
            const p = moved(k.slice(0, sep));
            if (p) nk = p + k.slice(sep);
          }
        }
        if (nk) updates.push([k, nk]);
      }
      for (const [k, nk] of updates) {
        map[nk] = map[k];
        delete map[k];
        changed = true;
      }
    }
    for (const arrKey of ["favorites", "hideRules"]) {
      const arr = this.settings[arrKey];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const nk = moved(arr[i]);
        if (nk) {
          arr[i] = nk;
          changed = true;
        }
      }
    }
    if (changed) void this.saveSettings();
    if (this.__traceMark) this.__traceMark("icons.migrate(host槽重键)", Date.now() - __t);
  }

  // ---- perf trace (v2.7.2 diagnostics) -----------------------------------------
  // One trace per rename event storm: opened by whichever rename handler runs
  // first, extended by every marked segment, flushed to the console 1.5s after
  // the last plugin activity. The table shows PLUGIN-side costs only — the
  // felt freeze minus the table's total is Obsidian core + sync.
  __traceOpen(trigger) {
    if (!this.__trace) this.__trace = { trigger: "", t0: Date.now(), events: [] };
    if (!this.__trace.trigger && typeof trigger === "string") this.__trace.trigger = trigger;
    if (this.__traceTimer) clearTimeout(this.__traceTimer);
    this.__traceTimer = setTimeout(() => this.__traceFlush(), 1500);
  }
  __traceMark(name, ms) {
    if (!this.__trace || typeof name !== "string") return;
    this.__trace.events.push([name, Math.max(0, ms)]);
    if (this.__traceTimer) clearTimeout(this.__traceTimer);
    this.__traceTimer = setTimeout(() => this.__traceFlush(), 1500);
  }
  __traceFlush() {
    const tr = this.__trace;
    this.__trace = null;
    if (this.__traceTimer) {
      clearTimeout(this.__traceTimer);
      this.__traceTimer = null;
    }
    if (!tr || !tr.events.length) return;
    const agg = new Map();
    let sum = 0;
    for (const [name, ms] of tr.events) {
      const a = agg.get(name) || { n: 0, sum: 0, max: 0 };
      a.n++;
      a.sum += ms;
      if (ms > a.max) a.max = ms;
      agg.set(name, a);
      sum += ms;
    }
    const rows = Array.from(agg.entries())
      .sort((x, y) => y[1].sum - x[1].sum)
      .map(([name, a]) => "    " + name + "  ×" + a.n + "  " + a.sum + "ms (max " + a.max + "ms)")
      .join("\n");
    console.log(
      "[beautify] 🔍 rename trace 「" + tr.trigger + "」\n" +
        rows +
        "\n    ——— 插件侧合计(分段可重叠,仅作量级参考) " +
        sum +
        "ms;体感卡顿 − 此值 ≈ Obsidian 本体与同步的耗时"
    );
  }
  hostSettingsDefs() {
    const _this = this;
    const zh = this.isZh();
    const orderSettings = this.order?.store.settings;
    return [
      { heading: zh ? "通用" : "General" },
      {
        name: this.t("language"),
        desc: this.t("languageDescription"),
        render: function (setting) {
          setting.addDropdown(function (dropdown) {
            return dropdown
              .addOption("auto", _this.t("auto"))
              .addOption("zh", "中文")
              .addOption("en", "English")
              .setValue(_this.language)
              .onChange(function (value) {
                Promise.resolve(_this.setLanguage(languageFrom(value))).catch(function (e) {
                  console.error("[beautify] failed to switch language:", e);
                });
                if (_this.settingsTab) _this.settingsTab.redraw();
              });
          });
        },
      },
      { heading: zh ? "页面与子笔记" : "Pages & child notes" },
      {
        name: zh ? "子页面模板" : "Child page template",
        desc: zh
          ? "新建子笔记时套用的模板笔记路径,留空则新建空白笔记。支持 {{title}}、{{date}}、{{time}} 占位符。"
          : "Path of a template note applied to newly created child notes; empty creates blank notes. Supports {{title}}, {{date}} and {{time}}.",
        render: function (setting) {
          setting.addText(function (text) {
            return text
              .setValue(_this.settings.childTemplatePath)
              .setPlaceholder(zh ? "模板/子页面.md" : "templates/child.md")
              .onChange(function (value) {
                _this.settings.childTemplatePath = String(value || "").trim();
                void _this.saveSettings();
              });
          });
        },
      },
      {
        name: zh ? "首页模板" : "Home note template",
        desc: zh
          ? "通过\"开始书写\"创建首页时套用的模板笔记路径,留空则新建空白笔记。支持 {{title}}、{{folder}}、{{date}}、{{time}} 占位符。"
          : "Path of a template note applied when a home note is created; empty creates blank notes. Supports {{title}}, {{folder}}, {{date}} and {{time}}.",
        render: function (setting) {
          setting.addText(function (text) {
            return text
              .setValue(_this.settings.homeTemplatePath)
              .setPlaceholder(zh ? "模板/首页.md" : "templates/home.md")
              .onChange(function (value) {
                _this.settings.homeTemplatePath = String(value || "").trim();
                void _this.saveSettings();
              });
          });
        },
      },
      {
        name: zh ? "显示子项计数" : "Show child counts",
        desc: zh
          ? "在文件列表的文件夹名旁显示可见子项数量(不含首页笔记与配置笔记)。"
          : "Show the number of visible children next to folder names in the file explorer (home notes and the config note excluded).",
        control: { type: "toggle", key: "showCounts" },
      },
      {
        name: zh ? "内链创建即子页面" : "Links create child pages",
        desc: zh
          ? "在首页笔记里点击未解析的内部链接(如 [[新页面]])时,新笔记自动创建在该目录下,而不是默认的新笔记位置。"
          : "Clicking an unresolved internal link inside a home note creates the new note inside that folder instead of the default location.",
        control: { type: "toggle", key: "linkCreatesChild" },
      },
      {
        name: zh ? "面包屑悬停显示子文档" : "Breadcrumb hover shows child notes",
        desc: zh
          ? "鼠标悬停文档顶部面包屑的任意目录段,弹出该目录的子文档列表(遵循文件列表的排序与隐藏规则,目录的首页笔记不重复列出),点击即打开——目录打开其首页笔记,文档直接打开,Ctrl/⌘ 点击在新标签页打开。点击面包屑本身保持原生行为(在系统文件管理器中显示该目录)。"
          : "Hover any folder segment of the breadcrumb at the top of a note to pop up that folder's child notes (same order and hide rules as the file explorer; a folder's home note is not repeated) — click to open it: folders via their home note, files directly, Ctrl/Cmd-click for a new tab. Clicking the breadcrumb itself keeps the native behaviour (reveal the folder in the system file manager).",
        render: function (setting) {
          setting.addToggle(function (tg) {
            return tg.setValue(_this.settings.breadcrumbChildren !== false).onChange(function (v) {
              _this.settings.breadcrumbChildren = v;
              _this.__crumbMenuRemove();
              void _this.saveSettings();
            });
          });
        },
      },
      {
        name: zh ? "显示别名" : "Show aliases",
        desc: zh
          ? "在文件列表中用笔记 frontmatter 的第一个 aliases 替换显示文件名(悬停可看到真实文件名)。"
          : "Show the first frontmatter alias instead of the file name in the file explorer (the real name appears on hover).",
        control: { type: "toggle", key: "showAliases" },
      },
      { heading: zh ? "排序" : "Sorting" },
      {
        name: zh ? "拖拽排序" : "Drag to reorder",
        desc: zh
          ? "在文件列表中把文件或文件夹拖到另一项的上/下边缘即可调整顺序,无需先打开「设置排序」弹窗;拖到文件夹中间仍执行原生移入。"
          : "Drag a file or folder onto the top/bottom edge of another item in the file explorer to reorder it; dropping onto a folder's middle still moves items into it.",
        render: function (setting) {
          setting.addToggle(function (toggle) {
            return toggle
              .setValue(orderSettings ? orderSettings.dragToReorder !== false : true)
              .onChange(function (value) {
                void _this.order?.store.setSettings({ dragToReorder: value });
              });
          });
        },
      },
      {
        name: zh ? "移动菜单项" : "Move menu items",
        desc: zh
          ? "右键文件/文件夹显示上移、下移、置顶、置底(四个命令始终可绑定快捷键)。"
          : "Add move up, move down, move to top and move to bottom to the right-click menu (the four commands stay available for hotkeys either way).",
        render: function (setting) {
          setting.addToggle(function (toggle) {
            return toggle
              .setValue(orderSettings ? orderSettings.showMoveActions === true : false)
              .onChange(function (value) {
                void _this.order?.store.setSettings({ showMoveActions: value });
              });
          });
        },
      },
      {
        subheading: zh ? "维护" : "Maintenance",
      },
      {
        name: zh ? "移除失效目录的排序" : "Remove stale orders",
        desc: zh
          ? "删除已不在库中的目录的保存排序(目录被删除或重命名时插件未运行所致);仍然存在的目录不受影响。"
          : "Remove saved orders for folders that are no longer in the vault; existing folders are never affected.",
        render: function (setting) {
          setting.addButton(function (btn) {
            return btn
              .setButtonText(zh ? "移除" : "Remove")
              .onClick(function () {
                const n = _this.order ? _this.order.removeStaleOrders() : 0;
                new obsidian.Notice(
                  zh ? "已移除 " + n + " 条失效排序。" : "Removed " + n + " stale order(s).",
                  4000
                );
              });
          });
        },
      },
      { heading: zh ? "交互" : "Interactions" },
      {
        name: zh ? "双击展开/收起子项" : "Double-click expands/collapses",
        desc: zh
          ? "在文件列表中双击仍有子文档的文档时,展开其子文档列表,再次双击收起;单击仅打开笔记;折叠箭头保持原生的展开/折叠切换。"
          : "Double-click a page with child notes in the file explorer to expand its child list; double-click again to collapse. A single click just opens the note; the collapse caret keeps the native toggle.",
        control: { type: "toggle", key: "dblClickExpand" },
      },
      {
        name: zh ? "隐藏此项菜单项" : "\"Hide this\" menu item",
        desc: zh
          ? "右键文件/文件夹提供\"隐藏此项\",直接把它的路径加入隐藏规则。"
          : "Right-click → Hide this adds the item's path to the hide rules directly.",
        control: { type: "toggle", key: "enableHideItem" },
      },
      {
        name: zh ? "文档收藏" : "Document favorites",
        desc: zh
          ? "在文件列表顶部显示收藏区;右键文件/文件夹可收藏/取消收藏。"
          : "Show a favorites section at the top of the file explorer; right-click to favorite/unfavorite items.",
        control: { type: "toggle", key: "enableFavorites" },
      },
      {
        name: zh ? "最近打开" : "Recently opened",
        desc: zh
          ? "在文件列表顶部显示最近打开的笔记(收藏过的不再重复显示)。"
          : "Show recently opened notes at the top of the file explorer (favorites are not repeated).",
        control: { type: "toggle", key: "enableRecent" },
      },
      {
        name: zh ? "空首页退格删除" : "Backspace deletes an empty home note",
        desc: zh
          ? "首页笔记正文完全为空时,在编辑器里按退格(删除)键即删除该首页——等价于右键「删除首页」:进系统回收站、可用「撤销上次页面操作」恢复;正文非空时退格仍是正常编辑。"
          : "With a strictly empty home note, pressing Backspace in the editor deletes it — same as right-click \"Delete home note\": to the system trash, restorable via \"Undo last page action\"; non-empty notes keep normal editing.",
        control: { type: "toggle", key: "enableEmptyHomeDelete" },
      },
      { heading: zh ? "隐藏文件" : "Hidden files" },
      {
        name: zh ? "隐藏规则" : "Hide rules",
        desc: zh
          ? "每行一条。不含 / 的规则按名称隐藏任意同名文件夹(如 attachments、assets);含 / 的规则按路径隐藏该项及其全部子内容(如 attachments/file)。左上角的眼睛按钮可临时显示被隐藏的文件,此时右键该项可选\"取消隐藏此项\"。"
          : "One rule per line. A rule without / hides any folder with that name (e.g. attachments); a rule with / hides that path and everything inside it. The eye button in the left ribbon temporarily reveals hidden items; right-click a revealed item to unhide it.",
        render: function (setting) {
          setting.addTextArea(function (area) {
            return area
              .setValue(_this.hideRules().join("\n"))
              .setPlaceholder("attachments\nassets\n私人/日记")
              .onChange(function (value) {
                _this.settings.hideRules = String(value || "")
                  .split("\n")
                  .map(function (x) { return x.trim(); })
                  .filter(function (x) { return x !== ""; });
                void _this.saveSettings().then(function () {
                  _this.refresh();
                  _this.refreshChildrenBlocks();
                });
              });
          });
        },
      },
      {
        name: zh ? "显示被隐藏的文件" : "Show hidden files",
        desc: zh
          ? "临时忽略隐藏规则,在文件列表中显示全部文件(左上角眼睛按钮相同作用)。"
          : "Temporarily ignore the hide rules and show everything in the file explorer (same as the eye button).",
        control: { type: "toggle", key: "showHidden" },
      },
      { heading: zh ? "图标" : "Icons" },
      {
        name: zh ? "新文档自动图标" : "Auto icon for new notes",
        desc: zh
          ? "新建笔记时自动随机分配一个线条图标(配置笔记除外)。"
          : "Auto-assign a random lucide icon to newly created notes (the config note is excluded).",
        control: { type: "toggle", key: "autoIcon" },
      },
      {
        name: zh ? "清除全部图标" : "Clear all icons",
        desc: zh
          ? "移除所有条目图标(包括从 Iconic 迁移的与手动设置的)。需要点击两次确认。"
          : "Remove every item icon (migrated from Iconic and manually set). Requires a second confirming click.",
        render: function (setting) {
          setting.addButton(function (btn) {
            return btn
              .setButtonText(
                _this.__iconClearArmed ? (zh ? "确认清除" : "Confirm") : zh ? "清除全部" : "Clear all"
              )
              .setDestructive()
              .onClick(function () {
                if (!_this.__iconClearArmed) {
                  _this.__iconClearArmed = true;
                  if (_this.settingsTab) _this.settingsTab.redraw();
                  return;
                }
                _this.__iconClearArmed = false;
                _this.settings.icons = {};
                void _this.saveSettings().then(function () {
                  _this.decorate();
                  _this.refreshChildrenBlocks();
                  if (_this.settingsTab) _this.settingsTab.redraw();
                });
              });
          });
        },
      },
      { heading: zh ? "视图" : "View" },
      {
        name: zh ? "自动切换视图模式" : "Auto view mode",
        desc: zh
          ? "打开笔记时按其属性自动切换视图:preview / reading = 阅读视图,edit / live = 实时预览,source = 源码模式;每个标签页只应用一次,之后手动切换不被覆盖;点编辑器右上角切换(或 Ctrl+E)即切换并记忆该笔记,切回库默认视图自动清除记忆。"
          : "Switch views on open per note property: preview / reading = Reading View, edit / live = Live Preview, source = Source Mode; applied once per tab so manual switches stick; the editor's own top-right toggle (or Ctrl+E) switches AND remembers the note, and flipping back to the vault default clears it.",
        control: { type: "toggle", key: "enableViewMode" },
      },
      {
        name: zh ? "视图模式属性名" : "View-mode property key",
        desc: zh
          ? "读取笔记的哪个属性来判断视图模式,留空恢复默认 auto-view-mode。示例:auto-view-mode: reading"
          : "Which frontmatter key holds the view mode; empty restores auto-view-mode. Example: auto-view-mode: reading",
        render: function (setting) {
          setting.addText(function (text) {
            return text
              .setValue(_this.settings.viewModeKey)
              .setPlaceholder("auto-view-mode")
              .onChange(function (value) {
                _this.settings.viewModeKey = String(value || "").trim();
                void _this.saveSettings();
              });
          });
        },
      },
      { heading: zh ? "任务" : "Tasks" },
      {
        name: zh ? "任务管理" : "Task management",
        desc: zh
          ? "在编辑器中输入 [] 加空格快速创建任务并即时盖上 ➕ 创建日期;任务元数据(➕ 创建 ✅ 完成 ❌ 取消 🛫 开始 ⏳ 计划 📅 截止、优先级)全部以表情字段写在任务行内——随库同步、任何编辑器可见;勾选自动盖 ✅ 日期;悬停任务行出现 [图标] [编辑] [转子页面] 工具条;阅读视图的复选框可直接勾选回写。"
          : "Type [] + space to create a task with an inline ➕ created stamp; ALL task metadata (➕ created ✅ done ❌ cancelled 🛫 start ⏳ scheduled 📅 due, priority) lives inline as emoji fields — synced with the vault, visible in every editor; checking a task stamps ✅; hovering a task line shows the [icon][edit][promote] bar; reading-view checkboxes toggle back into the file.",
        render: function (setting) {
          setting.addToggle(function (tg) {
            return tg.setValue(_this.settings.enableTasks).onChange(function (v) {
              _this.settings.enableTasks = v;
              _this.__removeTaskFloat();
              void _this.saveSettings()
                .then(function () {
                  if (v) void _this.__taskIndexAll();
                  else {
                    _this.__taskIndex.clear();
                    _this.__bumpTaskVersion();
                  }
                  _this.refreshTaskViews();
                })
                .catch(function (e) {
                  console.error("[beautify] failed to toggle tasks:", e);
                });
            });
          });
        },
      },
      {
        name: zh ? "任务行显示日期字段" : "Show task date fields",
        desc: zh
          ? "默认关闭:笔记中的任务行隐藏行内日期字段(➕ 创建 ✅ 完成 ❌ 取消 🛫 开始 ⏳ 计划),仅显示正文、📅 截止与优先级;字段仍完整保存在任务行内,实时预览/源码中光标所在行自动显示完整内容,编辑弹窗不受影响。打开后各处按原样显示。任务视图卡片上的 ➕/✅/❌ 时间戳标签同样跟随本开关。"
          : "Off by default: task lines in notes hide their inline date fields (➕ created ✅ done ❌ cancelled 🛫 start ⏳ scheduled), showing only the text, 📅 due and the priority; the fields stay fully saved in the line, the line under the cursor shows its full content in live preview/source, and the edit modal is unaffected. Turn on to display every field as written. The ➕/✅/❌ chips on dashboard cards follow the same toggle.",
        render: function (setting) {
          setting.addToggle(function (tg) {
            return tg.setValue(_this.settings.showTaskDates === true).onChange(function (v) {
              _this.settings.showTaskDates = v;
              document.body.classList.toggle("bn-show-task-dates", v);
              _this.__kickTaskDateDecorations();
              void _this.saveSettings().then(function () {
                _this.refreshTaskViews();
              });
            });
          });
        },
      },
      {
        name: zh ? "任务视图" : "Tasks view",
        desc: zh
          ? "打开(首次自动创建)「任务视图」文档:一个代码块渲染全部任务的仪表盘——工作台(统计卡片、今日聚焦、优先级分布、最近完成)、看板(待办/已完成/已取消三列,卡片可拖拽换状态)、四象限(按重要×紧急自动分象限)。阅读与实时预览均可用,任务变动自动刷新。"
          : "Open (auto-created on first use) the Tasks note: one code block renders the dashboard — workbench (stats, today focus, priority bars, recent done), kanban (todo/done/cancelled columns, drag cards to change status), four quadrants (auto-classified by importance x urgency). Works in reading and live preview; refreshes as tasks change.",
        render: function (setting) {
          setting.addButton(function (btn) {
            return btn
              .setButtonText(zh ? "打开" : "Open")
              .onClick(function () {
                void _this.openTasksNote();
              });
          });
        },
      },
    ];
  }

  // ---- absorbed Branch Note: persisted state --------------------------------
  async loadBranchData() {
    const slot = await this.readSlot("branchNote");
    this.language = languageFrom(slot.language);
    if (slot.drafts && typeof slot.drafts === "object") {
      for (const draft of Object.values(slot.drafts)) {
        if (
          draft &&
          typeof draft.folder === "string" &&
          typeof draft.content === "string" &&
          draft.before &&
          typeof draft.before.content === "string" &&
          (draft.before.path === undefined || typeof draft.before.path === "string")
        )
          this.drafts[draft.folder] = {
            folder: draft.folder,
            content: draft.content,
            before: draft.before,
          };
      }
    }
  }
  saveBranchData() {
    return this.writeSlot("branchNote", { language: this.language, drafts: this.drafts });
  }
  async retainDraft(draft) {
    this.drafts[draft.folder] = draft;
    await this.saveBranchData();
    new obsidian.Notice(this.t("unsaved"));
  }
  async clearDraft(folder) {
    if (this.drafts[folder]) {
      delete this.drafts[folder];
      await this.saveBranchData();
    }
  }
  async setLanguage(language) {
    this.language = language;
    await this.saveBranchData();
    for (const entry of this.commandLabels) {
      entry.command.name = this.manifest.name + ": " + this.t(entry.key);
    }
    for (const leaf of this.app.workspace.getLeavesOfType(HOME_VIEW)) {
      if (leaf.view instanceof HomeView) leaf.view.updateLanguage();
    }
  }
  isZh() {
    try {
      return resolveLanguage(this.language, (0, obsidian.getLanguage)())
        .toLowerCase()
        .startsWith("zh");
    } catch (e) {
      return false;
    }
  }
  warnAboutLegacyPlugins() {
    const labels = {
      "branch-note": "Branch Note",
      "explorer-order-editor": "Explorer Order Editor",
      "branch-order": "Branch & Order(旧合并版)",
      iconic: "Iconic(图标功能已并入 Beautify)",
      "hide-folders": "Hide Folders(隐藏功能已并入 Beautify)",
    };
    const loaded = this.app.plugins?.plugins ?? {};
    const names = LEGACY_PLUGIN_IDS.filter((id) => loaded[id]).map((id) => labels[id] || id);
    if (!names.length) return;
    const zh = this.isZh();
    new obsidian.Notice(
      zh
        ? "Beautify:检测到旧插件 " +
          names.join("、") +
          " 仍在运行,会与合并插件冲突。请在 设置 → 第三方插件 中禁用它们(数据已自动迁移,排序和首页笔记均不受影响)。"
        : "Beautify: the legacy plugin(s) " +
          names.join(", ") +
          " are still running and conflict with this one. Disable them in Settings → Community plugins (your data has been migrated).",
      10000
    );
  }

  // ---- absorbed Branch Note: startup / teardown ------------------------------
  startBranchNote() {
    this.alive = true;
    this.__bnActive = true;
    const manager = this.app.fileManager;
    const previous = manager.renameFile;
    const hadOwn = Object.hasOwn(manager, "renameFile");
    this.files = new ObsidianFiles(
      this.app,
      async (file, to) => {
        const key = file.path + "\n" + to;
        this.ownMoves.add(key);
        try {
          await manager.renameFile(file, to);
        } finally {
          this.ownMoves.delete(key);
        }
      },
      this.templateApplier()
    );
    this.service = new BranchService(this.files);
    // Folder renames keep the home note in step; renaming a home note renames
    // its folder; anything else keeps Obsidian's behaviour.
    const rename = async (file, to) => {
      if (!this.alive || this.ownMoves.has(file.path + "\n" + to))
        return previous.call(manager, file, to);
      if (file instanceof obsidian.TFolder) return this.service.renameFolder(file.path, to);
      const folder = pageFolder(this.files, file.path);
      if (folder && parentOf(to) === folder && /\.md$/i.test(to)) {
        return this.service.renameFolder(
          folder,
          joinPath(parentOf(folder), stemOf(baseOf(to)))
        );
      }
      return previous.call(manager, file, to);
    };
    manager.renameFile = rename;
    this.__bnRestoreRename = function () {
      if (manager.renameFile === rename) {
        if (hadOwn) manager.renameFile = previous;
        else delete manager.renameFile;
      }
    };
    this.registerView(HOME_VIEW, (leaf) => new HomeView(leaf, this));
    const add = (id, key, callback, checkCallback) => {
      const def = { id, name: this.t(key) };
      if (typeof checkCallback === "function") def.checkCallback = checkCallback;
      else def.callback = callback;
      const command = this.addCommand(def);
      this.commandLabels.push({ command, key });
    };
    add("new-child", "newChild", () => {
      const path = this.activePath();
      if (path) void this.create(path).catch((e) => this.report(e));
    });
    add("undo-page-action", "undo", () => {
      void this.service
        .undo()
        .then(() => {
          this.refresh();
          new obsidian.Notice(this.t("undone"));
        })
        .catch((e) => this.report(e));
    });
    add("delete-home", "deleteHome", () => {
      const path = this.activePath();
      const folder = path && pageFolder(this.files, path);
      if (folder) void this.deleteHome(folder).catch((e) => this.report(e));
    });
    add("recover-page", "recover", () => {
      if (Object.keys(this.drafts).length) new RecoveryModal(this).open();
      else new obsidian.Notice(this.t("chooseRecovery"));
    });
    // saved-order commands (native since v2.0.0, follow the plugin language)
    add(
      "set-order-for-vault-root",
      "setOrderRoot",
      () => this.order?.openModal(this.app.vault.getRoot())
    );
    add("clear-order-for-vault-root", "clearOrderRoot", null, (checking) => {
      const root = this.app.vault.getRoot();
      if (!this.order || this.order.store.get("/") === undefined) return false;
      if (!checking) this.order.clearFolderOrder(root);
      return true;
    });
    for (const [dir, key] of [
      ["up", "moveUp"],
      ["down", "moveDown"],
      ["top", "moveTop"],
      ["bottom", "moveBottom"],
    ]) {
      add("move-" + dir, key, null, (checking) => {
        const file = this.order?.fileUnderCursor();
        if (!file || !this.order.canMove(file, dir)) return false;
        if (!checking) void this.order.move(file, dir);
        return true;
      });
    }
    // source: "file-explorer-context-menu" | "more-options" (the view's
    // three-dot menu, with the leaf as 4th arg) | "tab-header" | …
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, source, leaf) => this.menu(menu, file, source, leaf))
    );
    this.registerEvent(this.app.workspace.on("layout-change", () => this.syncViews()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.decorate()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.decorate()));
    this.registerEvent(
      this.app.vault.on("create", () => {
        this.__countsDirty = true;
        this.refresh();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", () => {
        this.__countsDirty = true;
        this.refresh();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.__traceOpen) this.__traceOpen("rename: " + oldPath + " → " + (file.path || "?"));
        this.__countsDirty = true;
        this.refresh();
        if (file instanceof obsidian.TFolder && !this.ownMoves.has(oldPath + "\n" + file.path)) {
          const __t = Date.now();
          void this.service
            .followExternalRename(oldPath, file.path)
            .then(() => {
              if (this.__traceMark) this.__traceMark("branch.homeRename(含首页级联)", Date.now() - __t);
              this.refresh();
            })
            .catch((e) => {
              if (this.__traceMark) this.__traceMark("branch.homeRename(含首页级联)", Date.now() - __t);
              this.report(e);
            });
        }
      })
    );
    // Registered after OrderCore patched the prototype, so at layout-ready
    // the prototype patch exists before instance wrapping.
    // v2.10.7: cold-boot races healed with bounded retries — on an app START
    // (not a warm plugin toggle) the explorer view may not be ready yet and
    // the config note read may hit the un-indexed window; without retries
    // nothing mounts and the order store stays empty until the next
    // layout-change, which may never come.
    this.app.workspace.onLayoutReady(() => {
      if (!this.alive) return;
      this.syncViews();
      this.__bootRetryMount();
      this.__bootRetryOrderStore();
    });
  }
  // Retry explorer mounting while nothing is mounted (≤ ~4s). syncViews is
  // idempotent (already-mounted views are skipped).
  __bootRetryMount(attempt = 0) {
    if (!this.alive || this.delegatedViews.size > 0 || attempt >= 8) return;
    setTimeout(() => {
      if (!this.alive) return;
      if (this.delegatedViews.size === 0) {
        __bdiag("bootRetryMount: attempt " + attempt + " — explorer not mounted yet"); // [diag]
        try {
          this.syncViews();
        } catch (e) {
          console.error("[beautify] mount retry failed:", e);
        }
        this.__bootRetryMount(attempt + 1);
      }
    }, 500);
  }
  // Re-read the order store if the boot read came back empty (vault not
  // indexed yet / remotely-save mid-rewrite). A legal index arriving late is
  // adopted and applied; an honestly-empty vault stays empty.
  __bootRetryOrderStore(attempt = 0) {
    if (!this.alive || attempt >= 3) return;
    setTimeout(() => {
      if (!this.alive || !this.order) return;
      try {
        if (this.order.store.keys().size > 0) return; // healthy, nothing to do
        __bdiag("bootRetryOrderStore: attempt " + attempt + " — store empty, re-reading"); // [diag]
        void this.order.store.load().then(() => {
          if (this.order && this.order.store.keys().size > 0) {
            __bdiag("bootRetryOrderStore: recovered " + this.order.store.keys().size + " key(s)"); // [diag]
            this.refresh();
          } else this.__bootRetryOrderStore(attempt + 1);
        });
      } catch (e) {
        console.error("[beautify] order store re-read failed:", e);
      }
    }, attempt === 0 ? 1500 : 4000);
  }
  teardownBranchNote() {
    if (!this.__bnActive) return;
    this.__bnActive = false;
    this.alive = false;
    if (this.__refreshTimer) {
      clearTimeout(this.__refreshTimer);
      this.__refreshTimer = null;
    }
    if (this.__bnRestoreRename) {
      this.__bnRestoreRename();
      this.__bnRestoreRename = null;
    }
    // One view's cleanup must never abort the rest (v2.10.6): a throwing
    // restore here used to kill the whole loop — every later view kept its
    // icons, ＋ buttons and listeners, and the exception rippled up through
    // onunload skipping ALL remaining cleanup (patch restore, timers, flush).
    for (const restore of this.views.values()) {
      try {
        restore();
      } catch (e) {
        console.error("[beautify] failed to clean one explorer view:", e);
      }
    }
    this.views.clear();
    for (const disposable of this.itemClicks.values()) disposable.dispose();
    this.itemClicks.clear();
    this.delegatedViews.clear();
    this.files = null;
    this.service = null;
  }

  // ---- absorbed Branch Note: actions ----------------------------------------
  activePath() {
    try {
      const home = this.app.workspace.getActiveViewOfType(HomeView);
      return home?.folder?.path ?? this.app.workspace.getActiveFile()?.path;
    } catch (e) {
      console.error("[beautify] activePath failed:", e);
      return null;
    }
  }
  async create(path) {
    // v2.10.6: a straggler ＋ button (pre-hardening leftover) can still fire
    // after teardown — this.service is null then; fail soft instead of the
    // "Cannot read properties of null (reading 'createChild')" crash.
    if (!this.service || !this.alive) {
      console.warn("[beautify] create ignored — plugin is not active");
      return;
    }
    const result = await this.service.createChild(path, this.t("untitled"));
    await this.ensureChildLast(result.folder, baseOf(result.child));
    this.refresh();
    for (const view of Array.from(this.views.keys())) {
      await view.fileItems[result.folder]?.setCollapsed?.(false);
    }
    await this.openMarkdown(result.child, undefined, {
      state: { mode: "source" },
      eState: { rename: "all" },
    });
    new obsidian.Notice(this.t("created"));
  }
  // A freshly created child note is appended at the END of the folder's saved
  // order (materialising a saved order from the default sort when the folder
  // has none yet), so it reliably shows up last in the explorer.
  defaultOrderNames(folder) {
    const items = folder.children.slice();
    if (!this.collator) this.collator = new Intl.Collator(undefined, { numeric: true });
    const collator = this.collator;
    items.sort((a, b) => {
      const af = a instanceof obsidian.TFolder,
        bf = b instanceof obsidian.TFolder;
      if (af !== bf) return af ? -1 : 1;
      const r = collator.compare(a.name, b.name);
      return r !== 0 ? r : a.name < b.name ? -1 : 1;
    });
    return items.map((f) => f.name);
  }
  async ensureChildLast(folderPath, childName) {
    try {
      const store = this.order?.store;
      if (!store) return;
      const folder = this.app.vault.getAbstractFileByPath(folderPath || "/");
      if (!(folder instanceof obsidian.TFolder)) return;
      const key = folderKey(folder);
      store.update((index) => {
        const saved = index.get(key);
        let names;
        if (Array.isArray(saved)) {
          if (saved.includes(childName)) return index; // keep its position
          names = [...saved, childName];
        } else {
          names = this.defaultOrderNames(folder);
          if (!names.includes(childName)) names.push(childName);
        }
        return new Map(index).set(key, names);
      });
    } catch (e) {
      console.error("[beautify] failed to append the new note to the saved order:", e);
    }
  }
  // (v2.10.0) Pin removed: the "move to front of the saved order" menu item
  // and its helpers are gone — drag/Alt+arrows cover ordering.
  async openMarkdown(path, leaf, state = {}) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof obsidian.TFile)) throw new BranchError("missing", path);
    await (leaf ?? this.app.workspace.getLeaf(false)).openFile(file, {
      ...state,
      active: true,
    });
    this.decorate();
  }
  async openFolder(path, newTab = false) {
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!(folder instanceof obsidian.TFolder) || folder.isRoot()) return;
    const home = homeOf(this.files, path),
      leaf = this.app.workspace.getLeaf(newTab ? "tab" : false);
    if (home) await this.openMarkdown(home.path, leaf);
    else
      await leaf.setViewState({
        type: HOME_VIEW,
        state: { folder: path },
        active: true,
      });
    this.decorate();
  }
  async deleteHome(path) {
    const home = homeOf(this.files, path);
    const leaf = this.app.workspace.getLeaf(false);
    const previousViewState = leaf.getViewState();
    const showingHome =
      previousViewState.type === "markdown" && home && previousViewState.state?.file === home.path;
    if (showingHome)
      await leaf.setViewState({ type: HOME_VIEW, state: { folder: path }, active: true });
    try {
      await this.service.deleteHome(path);
    } catch (error) {
      if (showingHome && homeOf(this.files, path))
        await leaf.setViewState(previousViewState);
      throw error;
    }
    this.refresh();
    await this.openFolder(path);
    new obsidian.Notice(this.t("deleted"));
  }
  // ---- empty home note: Backspace/Delete deletes it (v2.8.0) -------------------
  // In a strictly empty home-note editor Backspace is a no-op, so hijacking the
  // key is unambiguous. Deletion reuses deleteHome(): the note goes to the
  // system trash and stays undoable (「撤销上次页面操作」). Guards: source mode,
  // editor focused, no modifiers, not mid-IME-composition, active file IS the
  // home note of its folder. (v2.11.1) "Empty" also covers a note whose only
  // content is the plugin's own view-mode key — the v2.9.0 toggle-pin writes
  // it into otherwise-empty notes, which used to silently kill this shortcut.
  __isEmptyHomeBody(text) {
    if (text === "") return true;
    const key = String(this.viewModeKey() || "").trim();
    if (!key) return false;
    const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!m) return false; // no frontmatter block → empty means exactly ""
    if (text.slice(m[0].length) !== "") return false; // any body after the block
    // Only a frontmatter holding NOTHING but our view-mode key counts as empty;
    // tags, aliases, other plugins' keys are real content → keep editing.
    const keyRe = new RegExp(
      "^\\s*" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:",
      "i"
    );
    return m[1].split(/\r?\n/).every((line) => line.trim() === "" || keyRe.test(line));
  }
  __onEmptyHomeDeleteKey(ev) {
    if (!this.settings.enableEmptyHomeDelete) return;
    if (ev.key !== "Backspace" && ev.key !== "Delete") return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return;
    if (!this.files) return;
    let view = null;
    try {
      view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    } catch (e) {
      return;
    }
    if (!view || view.currentMode?.type !== "source" || !view.editor) return;
    if (!view.editor.hasFocus()) return; // e.g. focus sits in the sidebar search box
    const file = view.file;
    if (!(file instanceof obsidian.TFile)) return;
    if (!this.__isEmptyHomeBody(view.editor.getValue())) return;
    let folder;
    try {
      folder = pageFolder(this.files, file.path);
    } catch (e) {
      return;
    }
    if (!folder) return; // not a home note
    ev.preventDefault();
    ev.stopPropagation();
    void this.deleteHome(folder).catch((e) => this.report(e));
  }
  // The right-click menu: page management, Beautify extras, saved-order items.
  menu(menu, file, source, leaf) {
    const zh = this.isZh();
    const isFolder = file instanceof obsidian.TFolder;
    const isRoot = isFolder && typeof file.isRoot === "function" && file.isRoot();
    const isMd = file instanceof obsidian.TFile && /\.md$/i.test(file.name || "");
    // Saved-order actions (folders get set/clear; everything gets moves).
    if (this.order && (isFolder || file instanceof obsidian.TFile)) {
      if (isFolder) {
        menu.addItem((item) =>
          item
            .setSection("beautify-order")
            .setTitle(zh ? (isRoot ? "设置根目录排序" : "设置排序") : isRoot ? "Set order (vault root)" : "Set order")
            .setIcon("arrow-up-down")
            .onClick(() => this.order.openModal(file))
        );
        if (this.order.store.get(folderKey(file)) !== undefined) {
          menu.addItem((item) =>
            item
              .setSection("beautify-order")
              .setTitle(zh ? "清除排序" : "Clear order")
              .setIcon("list-x")
              .onClick(() => this.order.clearFolderOrder(file))
          );
        }
      }
      if (this.order.store.settings.showMoveActions && file.parent) {
        for (const [dir, key, icon] of [
          ["up", "moveUp", "arrow-up"],
          ["down", "moveDown", "arrow-down"],
          ["top", "moveTop", "chevrons-up"],
          ["bottom", "moveBottom", "chevrons-down"],
        ]) {
          if (!this.order.canMove(file, dir)) continue;
          menu.addItem((item) =>
            item
              .setSection("beautify-order")
              .setTitle(this.t(key))
              .setIcon(icon)
              .onClick(() => void this.order.move(file, dir))
          );
        }
      }
    }
    // Home-note management (新建子笔记 moved to the hover + button)
    if (isFolder || isMd) {
      const folder = pageFolder(this.files, file.path);
      if (folder && homeOf(this.files, folder)) {
        menu.addItem((item) =>
          item
            .setSection("branch-note")
            .setTitle(this.t("deleteHome"))
            .setIcon("trash-2")
            .onClick(() => {
              void this.deleteHome(folder).catch((e) => this.report(e));
            })
        );
      }
    }
    if (isFolder || file instanceof obsidian.TFile) {
      menu.addItem((item) =>
        item
          .setSection("beautify-icon")
          .setTitle(zh ? "设置图标" : "Set icon")
          .setIcon("smile")
          .onClick(() => {
            this.openIconPicker(file);
          })
      );
      if (this.settings.enableHideItem) {
        // v2.11.0: rule-hiding items (revealed via the eye button) get the
        // inverse action instead — lifting every rule that hides them.
        const hidingRules = this.hideRulesFor(file);
        menu.addItem((item) =>
          item
            .setSection("beautify-hide")
            .setTitle(
              hidingRules.length
                ? zh
                  ? "取消隐藏此项"
                  : "Unhide this"
                : zh
                  ? "隐藏此项"
                  : "Hide this"
            )
            .setIcon(hidingRules.length ? "eye" : "eye-off")
            .onClick(() => {
              if (hidingRules.length) void this.removeHideRulesFor(file);
              else void this.addHideRuleFor(file);
            })
        );
      }
      if (this.settings.enableFavorites) {
        const favs = this.settings.favorites || [];
        const faved = favs.includes(file.path);
        menu.addItem((item) =>
          item
            .setSection("beautify-favorite")
            .setTitle(faved ? (zh ? "取消收藏" : "Unfavorite") : zh ? "收藏" : "Favorite")
            .setIcon(faved ? "star-off" : "star")
            .onClick(() => {
              void this.toggleFavorite(file.path);
            })
        );
      }
    }
    // v2.10.0: the per-note view mode is set from the editor's own top-right
    // toggle (see persistToggledMode); the file right-click entries are gone.
    // v2.10.1: the three-dot view menu (source "more-options", leaf attached)
    // gains a "Source mode" item — the only mode the toggle can't reach.
    if (isMd && source === "more-options" && this.settings.enableViewMode) {
      const view =
        leaf && leaf.view instanceof obsidian.MarkdownView && leaf.view.file?.path === file.path
          ? leaf.view
          : null;
      let inSource = false;
      try {
        const s = view ? view.getState() : null;
        inSource = !!s && s.mode === "source" && !!s.source;
      } catch (e) {
        /* no check mark then */
      }
      menu.addItem((item) =>
        item
          .setSection("beautify-view-mode")
          .setTitle((inSource ? "✓ " : "") + (zh ? "源码模式" : "Source mode"))
          .setIcon("code")
          .onClick(() => void this.toggleNoteSourceMode(file, view, !inSource))
      );
    }
    // Per-folder sort mode on non-root folders
    if (isFolder && !isRoot) {
      const current = this.sortModeFor(file.path);
      const modes = [
        ["manual", zh ? "手动(跟随保存的排序)" : "Manual (saved order)"],
        ["name", zh ? "名称" : "Name"],
        ["mtime", zh ? "最近修改" : "Recently modified"],
        ["ctime", zh ? "创建时间" : "Recently created"],
      ];
      for (const [mode, label] of modes) {
        menu.addItem((item) =>
          item
            .setSection("branch-order-sort")
            .setTitle((current === mode ? "✓ " : "") + (zh ? "排序:" : "Sort: ") + label)
            .onClick(() => {
              void this.setSortMode(file.path, mode);
            })
        );
      }
    }
  }
  report(error) {
    new obsidian.Notice(
      this.t(error instanceof BranchError ? error.code : "failure") +
        "\n" +
        (error instanceof BranchError ? error.detail : String(error)),
      8000
    );
  }

  // ---- per-note view mode (v2.7.0) --------------------------------------------
  // Rewrite of the auto-view-mode approach, tuned for cost:
  //  * no layout-change listener and no applied-path Set to prune — a
  //    WeakMap<leaf, path> gives one-shot-per-tab semantics for free and
  //    garbage-collects with the leaf (the reference plugin rescanned every
  //    workspace leaf on each layout-change to prune its Set).
  //  * the value->state map is a module constant, the opening tab is located
  //    by matching view.file among open markdown leaves, and a pending switch
  //    is dropped when the tab no longer shows the file or already sits in
  //    the target mode — the steady-state cost of opening a note is one scan
  //    of the open markdown tabs plus one metadataCache lookup.
  viewModeKey() {
    const key = this.settings.viewModeKey;
    return typeof key === "string" && key.trim() !== "" ? key.trim() : HOST_DEFAULTS.viewModeKey;
  }
  viewModeFor(file) {
    // undefined = cache not resolved yet (do not bookkeep; retry later);
    // null = definitively no saved mode for this note.
    if (!(file instanceof obsidian.TFile)) return null;
    let cache = null;
    try {
      cache = this.app.metadataCache.getFileCache(file);
    } catch (e) {
      return null;
    }
    // metadata not resolved yet (very cold start / freshly created): the
    // caller must skip bookkeeping so a later scan retries, not miss forever.
    if (!cache) return undefined;
    const raw = cache.frontmatter?.[this.viewModeKey()];
    if (typeof raw !== "string") return null;
    return VIEW_MODE_STATES[raw.trim().toLowerCase()] || null;
  }
  onFileOpenViewMode(file) {
    if (!this.settings.enableViewMode || !file) return;
    this.scanViewMode(file);
    // v2.8.2: file-open can fire while the opening tab is still swapping its
    // view (folder guide page → note, a brand-new tab, a background split):
    // leaf.view may not yet be the markdown view showing this file, so the
    // scan finds nothing and the saved mode is silently skipped. One deferred
    // re-scan closes that window. Idempotent — the per-leaf bookkeeping below
    // and the already-in-target-mode skip make a repeat scan a no-op.
    if (!this.__viewModePending) {
      this.__viewModePending = true;
      this.__viewModeTimer(() => {
        this.__viewModePending = false;
        if (this.alive) this.scanViewMode(file);
      }, 300);
    }
  }
  scanViewMode(file) {
    let leaves;
    try {
      // NB: workspace.getActiveLeaf() no longer exists on current Obsidian —
      // locate the tab(s) showing this file via getLeavesOfType instead.
      leaves = this.app.workspace.getLeavesOfType("markdown");
    } catch (e) {
      return;
    }
    // undefined = metadata cache not resolved yet (cold start / brand-new
    // note). Must NOT bookkeep in that case, or the per-leaf "last path"
    // would swallow the deferred re-scan above. The retry chain re-arms
    // while the cache is still cold (bounded).
    const patch = this.viewModeFor(file);
    if (patch === undefined) {
      this.__viewModeRetryCold(file, 0);
      return;
    }
    for (const leaf of leaves) {
      const view = leaf.view;
      if (!(view instanceof obsidian.MarkdownView) || view.file?.path !== file.path) continue;
      // Bookkeep EVERY open on this tab — keyless notes included — so
      // returning to a note after visiting another one re-applies its saved
      // mode (a keyless intermediate visit must still invalidate the path).
      const lastPath = this.__viewModeApplied.get(leaf);
      this.__viewModeApplied.set(leaf, file.path);
      if (patch && lastPath !== file.path) this.applyViewModeToLeaf(leaf, file, patch);
    }
  }
  // cold-cache re-arm: wait for metadataCache to resolve the file (≤ ~2s)
  __viewModeRetryCold(file, attempt) {
    if (attempt >= 6 || !this.alive) return;
    this.__viewModeTimer(() => {
      if (!this.alive) return;
      if (this.viewModeFor(file) === undefined) this.__viewModeRetryCold(file, attempt + 1);
      else this.scanViewMode(file);
    }, 300);
  }
  // Timer helper. Component.registerTimeout does NOT exist at runtime on the
  // Obsidian builds this plugin targets — the API surface ships
  // registerEvent / registerDomEvent / registerInterval but no
  // registerTimeout — so every apply crashed with "registerTimeout is not a
  // function" from v2.7.0 until v2.9.2. Bare timer + unload cleanup instead.
  __viewModeTimer(fn, ms) {
    const id = setTimeout(() => {
      this.__viewModeTimers.delete(id);
      fn();
    }, ms);
    this.__viewModeTimers.add(id);
    return id;
  }
  applyViewModeToLeaf(leaf, file, patch) {
    const view = leaf.view;
    if (!(view instanceof obsidian.MarkdownView) || view.file?.path !== file.path) return;
    let state = null;
    try {
      state = view.getState();
    } catch (e) {
      return;
    }
    // already in the target mode? skip the setState entirely
    if (
      state &&
      state.mode === patch.mode &&
      (patch.mode !== "source" || !!state.source === !!patch.source)
    )
      return;
    // v2.9.1: the apply retries. At +100ms the editor may still be mid-update
    // from opening the file, and CodeMirror rejects concurrent setState with
    // "update in progress" — an ASYNC rejection the old sync catch never saw,
    // so the mode silently never landed. Each attempt re-checks the leaf,
    // the file and the current mode; bounded, unload-cleaned timers.
    this.__scheduleViewModeApply(leaf, file.path, patch, 100, 0);
  }
  __scheduleViewModeApply(leaf, filePath, patch, delay, attempt) {
    this.__viewModeTimer(() => {
      const v = leaf.view; // re-resolve: the view may have been replaced
      if (!(v instanceof obsidian.MarkdownView) || v.file?.path !== filePath) return;
      let s = null;
      try {
        s = v.getState();
      } catch (e) {
        return;
      }
      if (s && s.mode === patch.mode && (patch.mode !== "source" || !!s.source === !!patch.source))
        return; // landed already (us or the user)
      const retry = () => {
        if (attempt >= 4) {
          console.error("[beautify] could not apply the saved view mode:", filePath, patch);
          return;
        }
        this.__scheduleViewModeApply(leaf, filePath, patch, 300 * (attempt + 1), attempt + 1);
      };
      try {
        const p = v.setState(Object.assign({}, s, patch), { history: false });
        if (p && typeof p.catch === "function") p.catch(retry);
      } catch (e) {
        retry();
      }
    }, delay);
  }
  async setNoteViewMode(file, value) {
    // value: "preview" | "edit" | "source" | null (clear the key)
    const key = this.viewModeKey();
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        if (value === null) delete fm[key];
        else fm[key] = value;
      });
    } catch (e) {
      console.error("[beautify] failed to write the view-mode key:", e);
      new obsidian.Notice(
        this.isZh()
          ? "Beautify:视图模式写入失败,详见控制台"
          : "Beautify: failed to write the view mode — see the console",
        6000
      );
      return;
    }
    // apply right away to every pane already showing this note
    if (value !== null) {
      const patch = VIEW_MODE_STATES[value];
      if (patch)
        for (const leaf of this.app.workspace.getLeavesOfType("markdown"))
          this.applyViewModeToLeaf(leaf, file, patch);
    }
  }
  // v2.10.1: "Source mode" item in the view's three-dot menu. The top-right
  // toggle only flips preview ↔ live preview; this reaches raw source. Same
  // persistence rules as the toggle: pin what is shown, auto-clear when it
  // matches the vault default, and sync other panes showing the note.
  async toggleNoteSourceMode(file, view, wantSource) {
    const patch = wantSource ? VIEW_MODE_STATES.source : VIEW_MODE_STATES.edit;
    const target =
      view instanceof obsidian.MarkdownView && view.file?.path === file.path ? view : null;
    if (target) {
      try {
        await target.setState(Object.assign({}, target.getState(), patch), { history: false });
      } catch (e) {
        console.error("[beautify] failed to switch the source mode:", e);
      }
      this.persistToggledMode(target); // pin/clear + sync other panes + notice
    } else {
      await this.setNoteViewMode(file, wantSource ? "source" : "edit");
    }
  }
  // ---- per-note view mode via the editor's own toggle (v2.9.0) ---------------
  // Every entry point that flips editing/reading on a note — the top-right
  // toggle button, the pane-menu item, the Mod+E command — ends in
  // WorkspaceLeaf.prototype.setViewState (verified against the 1.14.5
  // bundle). Hooking that ONE choke point covers them all, including the
  // button, which earlier prototype wraps (toggleMode, then onSwitchView)
  // kept missing: the button is registered as addAction(...,
  // view.onSwitchView.bind(view)), and that bind snapshots the function at
  // VIEW CREATION — every tab that predates the plugin (re)load keeps
  // calling the pristine original. setViewState, by contrast, is dispatched
  // through the prototype chain at call time. Persist only fires when
  // mode/source actually changed on the same file; the applier uses
  // view.setState (never the leaf's setViewState), so there is no feedback
  // loop.
  __patchToggleMode() {
    const proto = obsidian.WorkspaceLeaf?.prototype;
    const fn = proto?.setViewState;
    if (typeof fn !== "function" || fn.__beautify) return;
    const host = this;
    const original = fn;
    const wrapped = function () {
      let before = null;
      try {
        const v = this.view;
        if (v instanceof obsidian.MarkdownView && v.file) {
          const st = v.getState();
          before = { path: v.file.path, mode: st.mode, source: !!st.source };
        }
      } catch (e) {}
      const out = original.apply(this, arguments);
      Promise.resolve(out).then(() => {
        try {
          if (!before || !host.alive) return;
          const v = this.view;
          if (!(v instanceof obsidian.MarkdownView) || !v.file) return;
          if (v.file.path !== before.path) return; // file swap, not a mode flip
          const after = v.getState();
          if (after.mode === before.mode && !!after.source === before.source) return;
          host.persistToggledMode(v);
        } catch (e) {}
      }, () => {});
      return out;
    };
    wrapped.__beautify = true;
    wrapped.__original = original;
    proto.setViewState = wrapped;
  }
  __unpatchToggleMode() {
    const proto = obsidian.WorkspaceLeaf?.prototype;
    const fn = proto?.setViewState;
    if (typeof fn === "function" && fn.__beautify) proto.setViewState = fn.__original;
  }
  modeLabel(mode) {
    const zh = this.isZh();
    return mode === "reading"
      ? zh ? "阅读" : "reading"
      : mode === "source"
        ? zh ? "源码" : "source"
        : zh ? "编辑" : "edit";
  }
  persistToggledMode(view) {
    if (!this.settings.enableViewMode) return;
    if (!(view instanceof obsidian.MarkdownView)) return;
    const file = view.file;
    if (!(file instanceof obsidian.TFile)) return;
    let state = null;
    try {
      state = view.getState();
    } catch (e) {
      return;
    }
    let mode;
    if (state.mode === "preview") mode = "reading";
    else if (state.source) mode = "source";
    else mode = "edit";
    // The vault-wide default (defaultViewMode: preview|source) needs no key;
    // a "source" default renders as live preview, so "edit" is its default
    // form and raw "source" always stays pinned.
    const def = this.app.vault.getConfig?.("defaultViewMode") === "preview" ? "preview" : "source";
    const matchesDefault = def === "preview" ? mode === "reading" : mode === "edit";
    let current;
    try {
      current = this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.viewModeKey()];
    } catch (e) {
      current = undefined;
    }
    if (matchesDefault) {
      if (typeof current !== "string") return; // nothing pinned, nothing to clear
      void this.setNoteViewMode(file, null).then(() => {
        new obsidian.Notice(
          this.isZh() ? "Beautify:此笔记已恢复跟随默认视图" : "Beautify: this note now follows the default view",
          2000
        );
      });
    } else {
      if (current === mode) return; // already pinned to exactly this mode
      void this.setNoteViewMode(file, mode).then(() => {
        new obsidian.Notice(
          this.isZh()
            ? `Beautify:此笔记将始终以「${this.modeLabel(mode)}」模式打开`
            : `Beautify: this note now opens in ${this.modeLabel(mode)} mode`,
          2000
        );
      });
    }
  }

  // ---- absorbed Branch Note: explorer integration -----------------------------
  syncViews() {
    if (!this.alive) return;
    // v2.10.8: strip STALE instance wrappers left by a previous load whose
    // unload was interrupted (the v2.10.5 teardown-exception incident). A
    // fresh instance mounting this view for the first time can never have
    // wrapped it itself — any own getSortedFolderItems here chains through a
    // dead closure forever. Deleting the own prop restores the prototype
    // chain (OrderCore's prototype patch is unaffected); filterHomes then
    // wraps cleanly on top.
    for (const view of this.app.workspace.getLeavesOfType("file-explorer")) {
      try {
        if (view && Object.hasOwn(view, "getSortedFolderItems") && !this.views.has(view)) {
          const stale = view.getSortedFolderItems;
          if (typeof stale === "function" && stale.name === "filtered") {
            delete view.getSortedFolderItems;
            __bdiag("syncViews: removed a stale instance wrapper from an explorer view"); // [diag]
            if (typeof view.requestSort === "function") view.requestSort();
          }
        }
      } catch (e) {
        /* best-effort */
      }
    }
    const current = new Set();
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      if (!isExplorer(leaf.view)) continue;
      const view = leaf.view;
      current.add(view);
      if (this.views.has(view)) continue;
      const restore = filterHomes(view, this.files, (folderPath, items) =>
        this.arrangeExplorerItems(folderPath, items)
      );
      const restoreReveals = routeHomeReveals(view, this.files);
      let active = true,
        frame = 0;
      // Delegated capture-phase click handler on the container: runs before
      // Obsidian's own per-item listeners, so folder-title clicks reliably
      // open the home note.
      const containerClick = (event) => {
        if (!active) return;
        try {
          this.handleFolderClick(view, event);
        } catch (e) {
          console.error("[beautify] folder click handler failed:", e);
        }
      };
      const containerDblClick = (event) => {
        if (!active) return;
        try {
          this.handleFolderDblClick(view, event);
        } catch (e) {
          console.error("[beautify] folder dblclick handler failed:", e);
        }
      };
      view.containerEl.addEventListener("click", containerClick, true);
      view.containerEl.addEventListener("dblclick", containerDblClick, true);
      this.delegatedViews.add(view);
      const observer = new MutationObserver(() => {
        if (!frame)
          frame = view.containerEl.win.requestAnimationFrame(() => {
            frame = 0;
            if (active) this.decorateView(view);
          });
      });
      observer.observe(view.containerEl, { childList: true, subtree: true });
      this.views.set(view, () => {
        active = false;
        try {
          view.containerEl.removeEventListener("click", containerClick, true);
          view.containerEl.removeEventListener("dblclick", containerDblClick, true);
        } catch (e) {
          /* view already gone */
        }
        this.delegatedViews.delete(view);
        observer.disconnect();
        view.containerEl.win.cancelAnimationFrame(frame);
        restore();
        restoreReveals();
        view.containerEl
          .querySelectorAll(".bn-add-child,.bn-item-icon,.bn-quick")
          .forEach(function (el) {
            if (typeof el.remove === "function") el.remove();
          });
        view.__bn_quick = null;
        view.__bnQuickSig = null;
        view.containerEl
          .querySelectorAll(".bn-leaf,.bn-current")
          .forEach((el) => el.removeClass("bn-leaf", "bn-current"));
      });
    }
    for (const [view, teardown] of Array.from(this.views)) {
      if (!current.has(view)) {
        teardown();
        this.views.delete(view);
      }
    }
    this.decorate();
  }
  // Resolve the folder row ("page") a pointer event landed on; null when it
  // hit something else (a file row, our own controls, a rename field).
  clickedPage(view, event) {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return null;
    if (target.closest('.bn-add-child,.qt-handle,input,textarea,[contenteditable="true"]'))
      return null;
    const rowEl = target.closest(".nav-folder-title");
    if (!rowEl) return null;
    const path = typeof rowEl.getAttribute === "function" ? rowEl.getAttribute("data-path") : null;
    if (!path) return null;
    const item = view.fileItems ? view.fileItems[path] : undefined;
    const file = item && item.file;
    if (!(file instanceof obsidian.TFolder) || file.isRoot()) return null;
    if (view.fileBeingRenamed === file) return null;
    return { target, rowEl, item, file };
  }
  // A plain left click on a folder title opens the folder's home note (or its
  // "start writing" view); Ctrl/Cmd click opens it in a new tab. Shift clicks
  // and clicks on the collapse caret keep their native behaviour. Expanding
  // and collapsing the sub-list live on the DOUBLE click (双击展开/收起).
  handleFolderClick(view, event) {
    if (!this.alive || !event) return;
    if (event.button !== 0 || event.shiftKey) return;
    const hit = this.clickedPage(view, event);
    if (!hit) return;
    const { target, rowEl, item, file } = hit;
    let isLeaf = false;
    if (rowEl.classList && typeof rowEl.classList.contains === "function")
      isLeaf = rowEl.classList.contains("bn-leaf");
    else if (item.selfEl && typeof item.selfEl.hasClass === "function")
      isLeaf = item.selfEl.hasClass("bn-leaf");
    if (target.closest(".collapse-icon") && !isLeaf) return; // caret keeps native toggle
    event.preventDefault();
    event.stopPropagation();
    void this.openFolder(file.path, event.ctrlKey || event.metaKey).catch((e) => this.report(e));
  }
  // Double click toggles the sub-list (双击展开/收起): a collapsed page with
  // children expands, an expanded one collapses; the note opened by the
  // preceding single clicks stays open. Gated on dblClickExpand; the caret
  // keeps its native toggle.
  handleFolderDblClick(view, event) {
    if (!this.alive || !event) return;
    const hit = this.clickedPage(view, event);
    if (!hit) return;
    if (hit.target.closest(".collapse-icon")) return; // caret keeps native toggle
    if (this.settings.dblClickExpand === false) return;
    const { item, file, rowEl } = hit;
    if (typeof item.setCollapsed !== "function" || this.__folderInfo(file).visible === 0) return;
    event.preventDefault();
    event.stopPropagation();
    let collapsed = false;
    if (typeof item.collapsed === "boolean") collapsed = item.collapsed;
    else if (rowEl.classList && typeof rowEl.classList.contains === "function")
      collapsed = rowEl.classList.contains("is-collapsed");
    try {
      item.setCollapsed(!collapsed);
    } catch (e) {
      console.error("[beautify] failed to toggle the double-clicked page:", e);
    }
  }
  refresh() {
    if (!this.alive) return;
    // Leading call keeps single user actions instant; the trailing timer
    // coalesces event storms (e.g. sync writing thousands of files). Under a
    // real storm (more than 2 calls inside the 1s window — a 666-child folder
    // rename fires 1000+ vault events) the leading edge switches OFF: it used
    // to run refreshNow() on every event (~2000 runs, 37s of main-thread work
    // per measured storm). Isolated actions keep the instant leading refresh.
    const now = Date.now();
    const stormWindow = this.__refreshStormWindow || 1000;
    if (now - (this.__refreshStamp || 0) > stormWindow) this.__refreshBurst = 0;
    this.__refreshStamp = now;
    this.__refreshBurst = (this.__refreshBurst || 0) + 1;
    if (this.__refreshBurst <= 2) this.__refreshNow();
    if (!this.__refreshTimer) {
      this.__refreshTimer = setTimeout(() => {
        this.__refreshTimer = null;
        this.__refreshNow();
      }, 150);
    }
  }
  __refreshNow() {
    const __t = Date.now();
    this.__pruneBtnPath();
    for (const view of Array.from(this.views.keys())) view.requestSort();
    this.decorate();
    if (this.__traceMark) this.__traceMark("host.refreshNow(排序+装饰)", Date.now() - __t);
  }
  decorate() {
    if (!this.alive) return; // v2.10.6: late timers must not re-decorate after unload
    this.__passMemo = new Map();
    for (const view of Array.from(this.views.keys())) this.decorateView(view);
    try {
      this.trackActiveHome();
    } catch (e) {
      console.error("[beautify] failed to track the active home note:", e);
    }
    try {
      this.trackRecent();
      this.renderQuickAccessAll();
    } catch (e) {
      console.error("[beautify] failed to update quick access:", e);
    }
    this.__countsDirty = false;
  }
  // ---- favorites & recent (quick access) ------------------------------------
  trackRecent() {
    const file = this.app.workspace.getActiveFile ? this.app.workspace.getActiveFile() : null;
    if (!(file instanceof obsidian.TFile) || !/\.md$/i.test(file.name || "")) return;
    if (!this.__recent) this.__recent = [];
    if (this.__recent[0] === file.path) return;
    this.__recent = [file.path]
      .concat(this.__recent.filter((p) => p !== file.path))
      .slice(0, 8);
  }
  renderQuickAccessAll() {
    for (const view of Array.from(this.views.keys())) this.renderQuickAccess(view);
  }
  __quickRow(parent, file) {
    const isFolder = file instanceof obsidian.TFolder;
    const row = parent.createDiv({ cls: "bn-quick-row" });
    const icon = row.createEl("span", { cls: "bn-quick-icon" });
    const emoji = this.extraIconOf(file.path);
    if (emoji) {
      if (/[^\x00-\x7F]/.test(emoji)) {
        if (typeof icon.setText === "function") icon.setText(emoji);
      } else {
        try {
          (0, obsidian.setIcon)(icon, emoji);
        } catch (e) {
          /* keep blank */
        }
      }
    } else {
      try {
        (0, obsidian.setIcon)(icon, isFolder ? "folder" : "file-text");
      } catch (e) {
        /* keep blank */
      }
    }
    row.createEl("span", {
      cls: "bn-quick-label",
      text: isFolder ? file.name : file.basename || file.name,
    });
    row.addEventListener("click", (ev) => {
      if (isFolder) {
        void this.openFolder(file.path, ev.ctrlKey || ev.metaKey);
        return;
      }
      const leaf = this.app.workspace.getLeaf(ev.ctrlKey || ev.metaKey ? "tab" : false);
      void leaf.openFile(file);
    });
    return row;
  }
  renderQuickAccess(view) {
    if (!view || !view.containerEl) return;
    const containerEl = view.containerEl;
    const favs = (this.settings.favorites || []).filter(function (p) {
      return !!this.app.vault.getAbstractFileByPath(p);
    }, this);
    const recents = (this.__recent || []).filter(function (p) {
      return favs.indexOf(p) === -1 && !!this.app.vault.getAbstractFileByPath(p);
    }, this);
    // v2.10.0: favorites and recent are independent sections with their own
    // toggles; the area hides itself when neither is enabled/has content.
    const showFavs = !!this.settings.enableFavorites && favs.length > 0;
    const showRecents = !!this.settings.enableRecent && recents.length > 0;
    const sig =
      (showFavs ? "F" + favs.join("|") : "") + "||" + (showRecents ? "R" + recents.join("|") : "");
    if (view.__bnQuickSig === sig) return;
    view.__bnQuickSig = sig;
    let el = view.__bn_quick;
    if (el && el.isConnected === false) view.__bn_quick = el = null;
    if (!el) {
      el = containerEl.createDiv({ cls: "bn-quick" });
      const anchor =
        typeof containerEl.querySelector === "function"
          ? containerEl.querySelector(".nav-files-container")
          : null;
      if (anchor && anchor.parentElement === containerEl && typeof containerEl.insertBefore === "function")
        containerEl.insertBefore(el, anchor);
      else if (typeof containerEl.insertBefore === "function" && containerEl.firstChild)
        containerEl.insertBefore(el, containerEl.firstChild);
      view.__bn_quick = el;
    }
    el.empty();
    if (!showFavs && !showRecents) {
      el.style.display = "none";
      return;
    }
    el.style.display = "";
    const zh = this.isZh();
    if (showFavs) {
      el.createDiv({ cls: "bn-quick-header", text: zh ? "收藏" : "Favorites" });
      for (const p of favs) this.__quickRow(el, this.app.vault.getAbstractFileByPath(p));
    }
    if (showRecents) {
      el.createDiv({ cls: "bn-quick-header", text: zh ? "最近" : "Recent" });
      for (const p of recents) this.__quickRow(el, this.app.vault.getAbstractFileByPath(p));
    }
  }

  // ---- task management (engine, obsidian-tasks model) -------------------------
  // No plugin-side task metadata: created/done/cancelled/due/priority live
  // INLINE as emoji fields on the task line, and the icon is the leading
  // emoji of the description. The plugin only indexes task LINES.
  __scheduleTaskRefresh() {
    if (this.__taskRefreshTimer) return;
    this.__taskRefreshTimer = setTimeout(() => {
      this.__taskRefreshTimer = null;
      this.refreshTaskViews();
    }, 300);
  }
  // v2.2.0: the task view is a NOTE ("任务视图.md") with a ```bn-tasks-view```
  // block; open blocks are tracked here and re-rendered when tasks change.
  registerTaskViewBlock(el) {
    this.taskViewBlocks.add(el);
    if (this.taskViewBlocks.size > 8) {
      for (const e of this.taskViewBlocks) {
        if (e.isConnected === false) this.taskViewBlocks.delete(e);
      }
    }
  }
  refreshTaskViews() {
    for (const el of Array.from(this.taskViewBlocks)) {
      if (el.isConnected === false) {
        this.taskViewBlocks.delete(el);
        continue;
      }
      try {
        el.empty();
        renderTasksViewBlock(this, el, el.__bnTvSource || "");
      } catch (e) {
        console.error("[beautify] failed to render the tasks view block:", e);
      }
    }
  }
  // v1.1.0: the date-fields toggle changed — every open editor rebuilds its
  // task-date decorations. A selection-only transaction (same anchor/head,
  // no scroll) makes the view update non-empty so ViewPlugin.update reruns;
  // reading view needs nothing (CSS body class already flipped by the caller).
  __kickTaskDateDecorations() {
    try {
      this.app.workspace.iterateAllLeaves((leaf) => {
        try {
          const cm = leaf.view && leaf.view.editor && leaf.view.editor.cm;
          if (cm && cm.state && cm.state.selection && typeof cm.dispatch === "function") {
            const sel = cm.state.selection.main;
            cm.dispatch(cm.state.update({ selection: { anchor: sel.anchor, head: sel.head } }));
          }
        } catch (e) {
          /* per-leaf best effort */
        }
      });
    } catch (e) {
      /* a settings toggle must never throw here */
    }
  }
  // Open (creating on first use) the task view note.
  async openTasksNote() {
    try {
      let file = this.app.vault.getFileByPath(TASK_VIEW_NOTE);
      if (!(file instanceof obsidian.TFile)) {
        const content = "```bn-tasks-view\n```\n";
        file = await this.app.vault.create(TASK_VIEW_NOTE, content);
        // a fixed icon for the dashboard note (beats the random auto-icon)
        const icons = Object.assign({}, this.settings.icons || {});
        if (!icons[TASK_VIEW_NOTE]) {
          icons[TASK_VIEW_NOTE] = "📋";
          this.settings.icons = icons;
          void this.saveSettings();
        }
        this.refresh();
      }
      await this.openMarkdown(file.path);
    } catch (e) {
      console.error("[beautify] failed to open the tasks note:", e);
      new obsidian.Notice(
        this.isZh() ? "无法打开任务视图文档" : "Could not open the tasks note",
        4000
      );
    }
  }
  // Set a task's status (kanban drag / checkbox): stamps ✅/❌ like toggle.
  async setTaskStatus(file, task, status) {
    try {
      if (status !== "todo" && status !== "done" && status !== "cancelled") return;
      if (task.status === status) return;
      const next = Object.assign({}, task, { status });
      next.statusChar = status === "cancelled" ? "-" : status === "done" ? "x" : " ";
      if (status === "done") next.doneDate = todayStr();
      else next.doneDate = "";
      if (status === "cancelled") next.cancelledDate = todayStr();
      else next.cancelledDate = "";
      await this.replaceTaskLine(file, task.raw, serializeTaskLine(next));
    } catch (e) {
      console.error("[beautify] failed to set the task status:", e);
    }
  }
  // Matrix drag (v2.3.0): dropping a card into a quadrant adjusts the two
  // fields the quadrant derives from — importance = priority (⏫ and above),
  // urgency = due date (today/overdue). Promotions fill the field in
  // (⏫ / due today); demotions clear the priority or push the due date a
  // week out; untouched axes keep their values.
  async setTaskQuadrant(file, task, quadrant) {
    try {
      if (quadrant < 0 || quadrant > 3) return;
      const toImportant = quadrant === 0 || quadrant === 1;
      const toUrgent = quadrant === 0 || quadrant === 2;
      const isImportant = IMPORTANT_PRIORITIES.includes(task.priority);
      const d = daysUntil(task.dueDate);
      const isUrgent = d !== null && d <= 1;
      const next = Object.assign({}, task);
      if (toImportant && !isImportant) next.priority = "⏫";
      if (!toImportant && isImportant) next.priority = "";
      if (toUrgent && !isUrgent) next.dueDate = todayStr();
      if (!toUrgent && isUrgent) {
        const pushed = new Date(Date.now() + 7 * 86400000);
        const p = (n) => (n < 10 ? "0" : "") + n;
        next.dueDate =
          pushed.getFullYear() + "-" + p(pushed.getMonth() + 1) + "-" + p(pushed.getDate());
      }
      if (next.priority === task.priority && next.dueDate === task.dueDate) return;
      await this.replaceTaskLine(file, task.raw, serializeTaskLine(next));
    } catch (e) {
      console.error("[beautify] failed to move the task across quadrants:", e);
    }
  }
  // One file changed: rescan it (cache-read once), then re-render (debounced).
  async __taskIndexFile(file, silent) {
    if (!this.settings.enableTasks) return;
    if (!(file instanceof obsidian.TFile) || !/\.md$/i.test(file.name)) return;
    if (this.isSystemNote(file.path)) return;
    try {
      const content = await this.app.vault.cachedRead(file);
      this.__taskIndex.set(file.path, scanTasks(content));
      this.__bumpTaskVersion();
      if (!silent) this.__scheduleTaskRefresh();
    } catch (e) {
      console.error("[beautify] failed to index tasks of " + file.path + ":", e);
    }
  }
  async __taskIndexAll() {
    if (!this.settings.enableTasks) return;
    await this.migrateLegacyTaskMeta();
    const files = this.app.vault.getMarkdownFiles().slice();
    for (let i = 0; i < files.length; i++) {
      if (!this.alive) return;
      const f = files[i];
      if (this.isSystemNote(f.path)) {
        this.__taskIndex.delete(f.path);
        continue;
      }
      if (this.isHidden(f)) {
        this.__taskIndex.delete(f.path);
        continue;
      }
      await this.__taskIndexFile(f, true);
      if (i % 60 === 59) await new Promise((r) => setTimeout(r, 0));
    }
    this.__scheduleTaskRefresh();
  }
  onTaskFileDeleted(file) {
    if (!(file instanceof obsidian.TFile)) return;
    this.__taskIndex.delete(file.path);
    this.__bumpTaskVersion();
    this.__scheduleTaskRefresh();
  }
  onTaskFileRenamed(file, oldPath) {
    this.__taskIndex.delete(oldPath);
    this.__bumpTaskVersion();
    if (file instanceof obsidian.TFile) {
      const tasks = this.__taskIndex.get(oldPath);
      if (tasks) this.__taskIndex.set(file.path, tasks);
      void this.__taskIndexFile(file, true);
    }
    this.__scheduleTaskRefresh();
  }
  // The index version is bumped on every mutation, so allTasks() can cache
  // its sorted result across the many re-renders one user action triggers.
  __bumpTaskVersion() {
    this.__taskIndexVersion = (this.__taskIndexVersion || 0) + 1;
  }
  allTasks() {
    const version = this.__taskIndexVersion || 0;
    if (this.__tasksCache && this.__tasksCache.version === version)
      return this.__tasksCache.list;
    const out = [];
    for (const path of Array.from(this.__taskIndex.keys())) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof obsidian.TFile)) continue;
      for (const task of this.__taskIndex.get(path) || []) out.push({ file, task });
    }
    out.sort(function (a, b) {
      if (a.task.status !== b.task.status)
        return a.task.status === "todo" ? -1 : 1;
      const ad = a.task.doneDate || a.task.cancelledDate || "";
      const bd = b.task.doneDate || b.task.cancelledDate || "";
      if (ad !== bd) return ad < bd ? 1 : -1;
      const ac = a.task.createdDate || "";
      const bc = b.task.createdDate || "";
      if (ac !== bc) return ac < bc ? 1 : -1;
      if (a.file.path !== b.file.path) return a.file.path < b.file.path ? -1 : 1;
      return a.task.line - b.task.line;
    });
    this.__tasksCache = { version, list: out };
    return out;
  }
  async openTaskSource(item) {
    try {
      await this.openMarkdown(item.file.path, undefined, {
        eState: { line: item.task.line },
      });
    } catch (e) {
      console.error("[beautify] failed to open the task source:", e);
    }
  }
  // Resolve a promoted task's document link (wiki OR markdown style) to its
  // TFile. Markdown targets are tried vault-relative, note-relative (the
  // style Obsidian generates with wikilinks off) and %20-decoded.
  taskLinkFile(text, fromPath) {
    const link = parseTaskLink(text);
    if (!link) return null;
    const raw = link.target;
    let dec = raw;
    try {
      dec = decodeURIComponent(raw);
    } catch (e) {
      /* keep the raw target */
    }
    const dir = parentOf(fromPath || "");
    const candidates = [];
    if (link.kind === "md") {
      if (dec.includes("/")) candidates.push(dec);
      if (dir) candidates.push(dir + "/" + dec); // relative to the source note
    }
    candidates.push(dec);
    for (const candidate of candidates) {
      const f = this.app.vault.getFileByPath((0, obsidian.normalizePath)(candidate));
      if (f instanceof obsidian.TFile) return f;
    }
    const lp = dec.replace(/\.md$/i, "").split("#")[0];
    const t = this.app.metadataCache.getFirstLinkpathDest(lp, fromPath || "");
    return t instanceof obsidian.TFile ? t : null;
  }
  openTaskEditModal(file, task) {
    new TaskEditModal(this.app, this, file, task).open();
  }
  // Generic emoji picker (reuses the icon library, emoji tab only — the icon
  // must be plain text to live inline in the task line).
  openEmojiPicker(hooks) {
    var host = this;
    var PickEmojiModal = class extends IconPickerModal {
      // v2.2.1: (app, plugin, file, task) — the 3-arg signature bound `null`
      // to `task` and silently DROPPED the hooks, crashing on file.path.
      constructor(app, plugin, file, task) {
        super(app, plugin, file, task);
        this.modalEl.addClass("bn-emoji-only");
      }
      onOpen() {
        super.onOpen();
        this.mode = "emoji";
        this.__shown = null;
        try {
          var btns = this.contentEl.querySelectorAll(".bn-icon-mode");
          for (var i = 0; i < btns.length; i++) btns[i].style.display = "none";
        } catch (e) {
          /* cosmetic */
        }
        this.renderGrid();
      }
    };
    new PickEmojiModal(this.app, this, null, {
      current: function () {
        return hooks.current();
      },
      pick: function (emoji) {
        hooks.pick(emoji);
      },
    }).open();
  }
  // Set the leading emoji of a task (its icon), rewriting the line inline.
  openTaskIconEditor(item) {
    var host = this;
    var file = item.file;
    var task = item.task;
    this.openEmojiPicker({
      current: function () {
        return task.icon || "";
      },
      pick: function (emoji) {
        var next = Object.assign({}, task, { icon: emoji || "" });
        void host.replaceTaskLine(file, task.raw, serializeTaskLine(next));
      },
    });
  }
  openTaskLineIconEditor(file, rawLine) {
    if (!(file instanceof obsidian.TFile)) return;
    const task = parseTaskLine(rawLine);
    if (!task) return;
    this.openTaskIconEditor({ file, task });
  }
  // Prefer a live editor over writing from disk state: open editors can hold
  // unsaved buffer content a disk-level rewrite would clobber.
  __editorForFile(file) {
    try {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const v = leaf.view;
        if (v && v.file === file && v.editor) return v.editor;
      }
    } catch (e) {
      /* fall back to disk */
    }
    return null;
  }
  __replaceLine(file, rawLine, newLine) {
    const editor = this.__editorForFile(file);
    if (editor) {
      for (let i = 0; i < editor.lineCount(); i++) {
        if (editor.getLine(i) === rawLine) {
          editor.setLine(i, newLine);
          return true;
        }
      }
      return false;
    }
    let done = false;
    void this.app.vault.process(file, function (data) {
      const lines = data.split("\n");
      for (let j = 0; j < lines.length; j++) {
        if (lines[j] === rawLine) {
          lines[j] = newLine;
          done = true;
          break;
        }
      }
      return done ? lines.join("\n") : data;
    });
    return done;
  }
  async replaceTaskLine(file, rawLine, newLine) {
    try {
      this.__replaceLine(file, rawLine, newLine);
      await this.__taskIndexFile(file);
      this.__scheduleTaskRefresh();
    } catch (e) {
      console.error("[beautify] failed to rewrite the task line:", e);
    }
  }
  // Remove the task LINE from its note (the edit modal's delete button).
  async deleteTaskLine(file, rawLine) {
    try {
      const editor = this.__editorForFile(file);
      if (editor) {
        for (let i = 0; i < editor.lineCount(); i++) {
          if (editor.getLine(i) === rawLine) {
            const last = i + 1 >= editor.lineCount();
            editor.replaceRange(
              "",
              { line: i, ch: 0 },
              last ? { line: i, ch: rawLine.length } : { line: i + 1, ch: 0 }
            );
            break;
          }
        }
      } else {
        await this.app.vault.process(file, function (data) {
          const lines = data.split("\n");
          const at = lines.indexOf(rawLine);
          if (at !== -1) lines.splice(at, 1);
          return lines.join("\n");
        });
      }
      await this.__taskIndexFile(file);
      this.__scheduleTaskRefresh();
      new obsidian.Notice(this.isZh() ? "已删除任务行" : "Task line deleted");
    } catch (e) {
      console.error("[beautify] failed to delete the task line:", e);
    }
  }
  // Toggle: mark done → status x + ✅ today (obsidian-tasks semantics:
  // re-completing refreshes the stamp); uncheck → back to todo, ✅ removed.
  async toggleTask(file, task) {
    try {
      const next = Object.assign({}, task);
      if (next.status === "todo") {
        next.status = "done";
        next.statusChar = "x";
        next.doneDate = todayStr();
      } else {
        next.status = "todo";
        next.statusChar = " ";
        next.doneDate = "";
        next.cancelledDate = "";
      }
      await this.replaceTaskLine(file, task.raw, serializeTaskLine(next));
    } catch (e) {
      console.error("[beautify] failed to toggle the task:", e);
    }
  }
  // Hover-button action: turn the task description into a link to a new
  // child page (folder-note semantics; keeps all inline fields intact).
  async promoteTask(file, rawLine) {
    try {
      const task = parseTaskLine(rawLine);
      if (!task) return;
      const text = task.description;
      if (!text) return;
      const existing = parseTaskLink(text);
      if (existing) {
        const openT = this.taskLinkFile(text, file.path);
        if (openT) await this.openMarkdown(openT.path);
        else await this.app.workspace.openLinkText(existing.target.split("#")[0], file.path);
        return;
      }
      if (!this.service) return;
      const name = taskPlainName(text);
      if (!name) return;
      const result = await this.service.createChild(file.path, name);
      await this.ensureChildLast(result.folder, baseOf(result.child));
      // creating the FIRST child promotes the note into a folder — re-resolve
      let targetFile = file;
      if (!(this.app.vault.getAbstractFileByPath(file.path) instanceof obsidian.TFile)) {
        const promoted = this.app.vault.getAbstractFileByPath(
          joinPath(result.folder, file.name)
        );
        if (promoted instanceof obsidian.TFile) targetFile = promoted;
        else return;
      }
      const childFile = this.app.vault.getAbstractFileByPath(result.child);
      if (!(childFile instanceof obsidian.TFile)) return;
      const link = this.app.fileManager.generateMarkdownLink(childFile, targetFile.path);
      const next = Object.assign({}, task, { description: link });
      await this.replaceTaskLine(targetFile, rawLine, serializeTaskLine(next));
      this.refresh();
      new obsidian.Notice(
        (this.isZh() ? "已创建子页面并转为链接:" : "Sub-page created and linked: ") + name
      );
    } catch (e) {
      this.report(e);
    }
  }
  // Reading-mode hover buttons arrive without line info — match by text.
  async promoteTaskByText(file, text) {
    try {
      const want = String(text || "").trim();
      if (!want) return;
      const content = await this.app.vault.cachedRead(file);
      for (const t of scanTasks(content)) {
        if (t.body === want || taskPlainName(t.body) === want) return this.promoteTask(file, t.raw);
      }
    } catch (e) {
      console.error("[beautify] failed to promote the task:", e);
    }
  }
  // ---- reading view: clickable checkbox + hover pencil ------------------------
  // The inline icon needs NO injection here — it is plain text in the line.
  decorateReadingTasks(el, ctx) {
    if (!this.settings.enableTasks) return;
    const items =
      typeof el.querySelectorAll === "function"
        ? el.querySelectorAll("li.task-list-item")
        : [];
    const host = this;
    for (const li of items) {
      (function (li) {
        // v1.1.0: hide the trailing date fields first (own guard — runs even
        // when the wiring below already ran on a re-processed section)
        bnWrapReadingTaskDates(li);
        if (li.__bnTaskWired) return;
        const checkbox = li.querySelector("input.task-list-item-checkbox");
        if (!checkbox) return;
        li.__bnTaskWired = true;
        // toggle from reading view: rewrite the line + stamp ✅
        checkbox.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          void host
            .matchReadingTask(li, ctx)
            .then(function (hit) {
              if (hit) void host.toggleTask(hit.__file, hit);
            })
            .catch(function () { /* decorative */ });
        });
        const btn = li.createEl("span", { cls: "bn-task-btn" });
        const label = host.isZh() ? "转为子页面" : "Turn into sub-page";
        btn.setAttribute("aria-label", label);
        btn.setAttribute("title", label);
        try {
          (0, obsidian.setIcon)(btn, "square-pen");
        } catch (e) {
          /* decorative */
        }
        btn.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          void host
            .matchReadingTask(li, ctx)
            .then(function (hit) {
              if (hit) void host.promoteTask(hit.__file, hit.raw);
            })
            .catch(function () { /* decorative */ });
        });
      })(li);
    }
  }
  // → { __file, ...task } | null
  // Matching strategy: TEXT FIRST. Section info spans the WHOLE task list in
  // reading view (one section per list), so "first task in section" matched
  // the wrong row whenever a list held several tasks; text is precise. The
  // rendered <li> text INCLUDES the inline emoji fields, so compare against
  // the full text AND its link-stripped/plain variants; section lines only
  // disambiguate duplicate texts.
  async matchReadingTask(li, ctx) {
    const file = this.app.vault.getAbstractFileByPath(ctx?.sourcePath || "");
    if (!(file instanceof obsidian.TFile)) return null;
    const content = await this.app.vault.cachedRead(file);
    const tasks = scanTasks(content);
    if (!tasks.length) return null;
    const clone = li.cloneNode(true);
    for (const n of clone.querySelectorAll("ul, .bn-task-btn")) n.remove();
    const want = String(clone.textContent || "").replace(/\s+/g, " ").trim();
    if (!want) return null;
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const matches = (t) =>
      norm(t.text) === want ||
      norm(taskPlainName(t.text)) === want ||
      norm(t.body) === want ||
      norm(taskPlainName(t.body)) === want;
    const hits = tasks.filter(matches);
    if (hits.length === 1) return Object.assign({ __file: file }, hits[0]);
    // duplicate texts (or a mangled render): disambiguate by section line
    try {
      const info = typeof ctx.getSectionInfo === "function" ? ctx.getSectionInfo(li) : null;
      if (info && typeof info.lineStart === "number") {
        const inSection = (t) =>
          t.line >= info.lineStart && t.line <= (info.lineEnd ?? info.lineStart);
        if (hits.length > 1) {
          const inRange = hits.filter(inSection);
          return Object.assign({ __file: file }, (inRange[0] || hits[0]));
        }
        // no text hit at all — accept the section ONLY if it holds one task
        const inRange = tasks.filter(inSection);
        if (inRange.length === 1) return Object.assign({ __file: file }, inRange[0]);
      }
    } catch (e) {
      /* section info unavailable */
    }
    if (hits.length > 1) return Object.assign({ __file: file }, hits[0]);
    return null;
  }
  // ---- task editor extras WITHOUT CodeMirror classes ---------------------------
  // [] + space expands to "- [ ] ➕ <today> " — the created date is stamped
  // INLINE immediately (obsidian-tasks model), no side-channel bookkeeping.
  __onTaskEditorChange(editor, info) {
    try {
      if (!this.settings.enableTasks || !this.alive) return;
      if (!editor || typeof editor.getCursor !== "function") return;
      const cursor = editor.getCursor("from");
      const line = editor.getLine(cursor.line);
      if (line == null) return;
      const before = line.slice(0, cursor.ch);
      // [] or ［］ (+ half/ideographic space) freshly typed at line start
      const m = before.match(/^(\s*)(\[\]|［］)([ ]|　)$/);
      if (!m) return;
      const indentLen = m[1].length;
      const mark = "- [ ] ➕ " + todayStr() + " ";
      editor.transaction({
        changes: [
          {
            from: { line: cursor.line, ch: indentLen },
            to: { line: cursor.line, ch: cursor.ch },
            text: mark,
          },
        ],
        selection: { from: { line: cursor.line, ch: indentLen + mark.length } },
      });
    } catch (e) {
      /* never disturb typing */
    }
  }
  __onTaskEditorMouseOver(ev) {
    try {
      if (!this.settings.enableTasks || !this.alive) return;
      const target = ev.target;
      if (!target || typeof target.closest !== "function") return;
      // Hovering the floating bar itself: keep it visible (else hide/show
      // flicker + unclickable buttons).
      if (this.__taskFloat && this.__taskFloat.contains(target)) return;
      const lineEl = target.closest(".cm-line");
      if (!lineEl) {
        this.__hideTaskFloat();
        return;
      }
      if (lineEl === this.__taskLastLineEl) return; // same line, keep state
      this.__taskLastLineEl = lineEl;
      const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      if (!view || !view.editor || !view.file || !view.contentEl) {
        this.__hideTaskFloat();
        return;
      }
      const cm = view.editor.cm;
      if (
        !cm ||
        typeof cm.posAtCoords !== "function" ||
        !cm.state ||
        !cm.state.doc ||
        typeof cm.state.doc.lineAt !== "function"
      ) {
        this.__hideTaskFloat();
        return;
      }
      const pos = cm.posAtCoords({ x: ev.clientX, y: ev.clientY });
      if (pos === null || pos === undefined) {
        this.__hideTaskFloat();
        return;
      }
      const line = cm.state.doc.lineAt(pos);
      if (!TASK_LINE_RE.test(line.text)) {
        this.__hideTaskFloat();
        return;
      }
      this.__showTaskFloat(view, lineEl, line.text, line.to);
    } catch (e) {
      /* hover is best-effort */
    }
  }
  // The hover bar: [icon][edit][promote]. The icon button shows the task's
  // INLINE leading emoji and edits it; edit opens the task modal; the pencil
  // promotes the task into a sub-page.
  __showTaskFloat(view, lineEl, lineText, endPos) {
    const host = this;
    const contentEl = view.contentEl;
    let bar = this.__taskFloat;
    if (!bar || !bar.isConnected || this.__taskFloatView !== view) {
      this.__removeTaskFloat();
      bar = contentEl.createEl("span", { cls: "bn-task-float" });
      bar.addEventListener("mousedown", function (ev) {
        ev.preventDefault();
      });
      const iconBtn = bar.createSpan({ cls: "bn-task-fbar-btn bn-task-fbar-icon" });
      const iconLabel = this.isZh() ? "设置任务图标(行首表情)" : "Set task icon";
      iconBtn.setAttribute("aria-label", iconLabel);
      iconBtn.setAttribute("title", iconLabel);
      iconBtn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const v = host.__taskFloatView;
        const text = bar.__bnLineText;
        if (v && v.file && text) host.openTaskLineIconEditor(v.file, text);
      });
      const editBtn = bar.createSpan({ cls: "bn-task-fbar-btn bn-task-fbar-edit" });
      const editLabel = this.isZh() ? "编辑任务" : "Edit task";
      editBtn.setAttribute("aria-label", editLabel);
      editBtn.setAttribute("title", editLabel);
      try {
        (0, obsidian.setIcon)(editBtn, "pencil");
      } catch (e) {
        /* decorative */
      }
      editBtn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const v = host.__taskFloatView;
        const text = bar.__bnLineText;
        if (!(v && v.file && text)) return;
        const task = parseTaskLine(text);
        if (task) host.openTaskEditModal(v.file, task);
      });
      const penBtn = bar.createSpan({ cls: "bn-task-fbar-btn bn-task-fbar-pen" });
      const penLabel = this.isZh() ? "转为子页面" : "Turn into sub-page";
      penBtn.setAttribute("aria-label", penLabel);
      penBtn.setAttribute("title", penLabel);
      try {
        (0, obsidian.setIcon)(penBtn, "square-pen");
      } catch (e) {
        /* decorative */
      }
      penBtn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const v = host.__taskFloatView;
        const text = bar.__bnLineText;
        host.__hideTaskFloat();
        if (v && v.file && text) void host.promoteTask(v.file, text);
      });
      this.__taskFloat = bar;
      this.__taskFloatView = view;
    }
    bar.__bnLineText = lineText;
    // refresh the icon button for the hovered task (inline leading emoji)
    const iconBtnEl = bar.querySelector(".bn-task-fbar-icon");
    if (iconBtnEl) {
      const task = parseTaskLine(lineText);
      const sig = (task && task.icon) || "";
      if (iconBtnEl.__bnIcon !== sig) {
        iconBtnEl.__bnIcon = sig;
        iconBtnEl.empty();
        if (task && task.icon) iconBtnEl.setText(task.icon);
        else {
          try {
            (0, obsidian.setIcon)(iconBtnEl, "smile");
          } catch (e) {
            /* decorative */
          }
        }
      }
    }
    const hostRect = contentEl.getBoundingClientRect();
    const size = 74; // the three-button bar
    const btnH = 22;
    let left = null,
      top = null;
    const cm = view.editor ? view.editor.cm : null;
    if (cm && typeof cm.coordsAtPos === "function" && endPos != null) {
      try {
        const coords = cm.coordsAtPos(endPos);
        if (coords && isFinite(coords.right) && isFinite(coords.top)) {
          left = coords.right - hostRect.left + 7;
          top = (coords.top + coords.bottom) / 2 - hostRect.top - btnH / 2;
        }
      } catch (e) {
        /* fall back to the line rect below */
      }
    }
    if (left === null) {
      const rect = lineEl.getBoundingClientRect();
      left = rect.right - hostRect.left + 6;
      top = rect.top - hostRect.top + (rect.height - btnH) / 2;
    }
    if (left > hostRect.width - size - 10) left = hostRect.width - size - 10;
    if (left < 4) left = 4;
    if (top < 2) top = 2;
    bar.style.left = Math.round(left) + "px";
    bar.style.top = Math.round(top) + "px";
    bar.addClass("is-visible");
  }
  __hideTaskFloat() {
    if (this.__taskFloat && typeof this.__taskFloat.removeClass === "function")
      this.__taskFloat.removeClass("is-visible");
    this.__taskLastLineEl = null;
  }
  __removeTaskFloat() {
    if (this.__taskFloat && typeof this.__taskFloat.remove === "function")
      this.__taskFloat.remove();
    this.__taskFloat = null;
    this.__taskFloatView = null;
    this.__taskLastLineEl = null;
  }
  // ---- one-time migration: v1/v2.0 taskMeta → inline fields -------------------
  // Old model kept created/done/icon in plugin settings keyed by path\u0001text.
  // Rewrite each affected task line inline (➕ ✅ + leading emoji), then drop
  // the whole taskMeta map.
  async migrateLegacyTaskMeta() {
    try {
      const meta = this.settings.taskMeta;
      if (!meta || typeof meta !== "object" || !Object.keys(meta).length) return;
      let changed = false;
      for (const key of Object.keys(meta)) {
        const sep = key.indexOf("\u0001");
        if (sep === -1) continue;
        const path = key.slice(0, sep);
        const text = key.slice(sep + 1);
        const entry = meta[key] || {};
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof obsidian.TFile) {
          try {
            const content = await this.app.vault.cachedRead(file);
            const task = scanTasks(content).find((t) => t.text === text || t.body === text || t.description === text);
            if (task) {
              const next = Object.assign({}, task);
              if (entry.created && !next.createdDate) next.createdDate = new Date(entry.created).toISOString().slice(0, 10);
              if (entry.done && !next.doneDate) next.doneDate = new Date(entry.done).toISOString().slice(0, 10);
              if (entry.icon && !next.icon) next.icon = entry.icon;
              if (next.status === "done" && next.doneDate) {
                /* keep as is */
              }
              await this.replaceTaskLine(file, task.raw, serializeTaskLine(next));
            }
          } catch (e) {
            console.error("[beautify] failed to migrate a legacy task entry:", e);
          }
        }
        delete meta[key];
        changed = true;
      }
      if (changed) {
        this.settings.taskMeta = {};
        await this.saveSettings();
        console.log("[beautify] migrated legacy task metadata to inline emoji fields");
      }
    } catch (e) {
      console.error("[beautify] legacy task migration failed:", e);
    }
  }

  // ---- explorer decorations ----------------------------------------------------
  // Per-pass memo: bn-leaf and the count badge both need a folder's visible
  // child count — computed once per folder per pass.
  __folderInfo(folder) {
    if (!this.__passMemo) this.__passMemo = new Map();
    const hit = this.__passMemo.get(folder.path);
    if (hit) return hit;
    const info = { visible: this.visibleChildrenOf(folder).length };
    this.__passMemo.set(folder.path, info);
    return info;
  }
  decorateView(view) {
    try {
      this.__decorateViewInner(view);
    } catch (e) {
      console.error("[beautify] decorateView failed:", e);
    }
  }
  __decorateViewInner(view) {
    const path = this.activePath(),
      activeFolder = path ? pageFolder(this.files, path) : undefined;
    for (const item of Object.values(view.fileItems)) {
      if (!item || !item.file || !item.selfEl) continue;
      const isFolderItem =
        item.file instanceof obsidian.TFolder &&
        !(typeof item.file.isRoot === "function" && item.file.isRoot());
      const folder = isFolderItem && canRepresentFolder(view, item.file.path);
      if (folder) {
        item.selfEl.toggleClass("bn-leaf", this.__folderInfo(item.file).visible === 0);
        item.selfEl.toggleClass("bn-current", item.file.path === activeFolder);
      } else {
        item.selfEl.toggleClass("bn-leaf", false);
        item.selfEl.toggleClass("bn-current", false);
      }
      this.decorateAddButton(view, item);
      this.decorateItemIcon(view, item);
      this.decorateAlias(item);
      if (isFolderItem) this.decorateCount(item);
    }
    try {
      this.updateCounts(view);
    } catch (e) {
      console.error("[beautify] failed to update folder counts:", e);
    }
  }
  // Hover "+" at the right end of a row: click creates a child note, exactly
  // like the 新建子笔记 command (folders grow a child; a plain note is
  // promoted into a page).
  decorateAddButton(view, item) {
    const selfEl = item.selfEl;
    if (!selfEl || typeof selfEl.createEl !== "function") return;
    const file = item.file;
    let eligible =
      (file instanceof obsidian.TFolder && !(typeof file.isRoot === "function" && file.isRoot())) ||
      (file instanceof obsidian.TFile && /\.md$/i.test(file.name || ""));
    if (this.isSystemNote(file.path)) eligible = false;
    let btn = item.__bnAddBtn;
    if (btn && btn.isConnected === false) btn = item.__bnAddBtn = null;
    if (!eligible) {
      if (btn) {
        if (typeof btn.remove === "function") btn.remove();
        if (this.__btnPath) this.__btnPath.delete(btn);
        item.__bnAddBtn = null;
      }
      return;
    }
    if (!btn) {
      // Obsidian recreates item objects while REUSING row DOM — clear any
      // spans orphaned by previous item objects before creating a new one.
      this.__clearOrphans(selfEl, ".bn-add-child", item, "__bnAddBtn");
      btn = selfEl.createEl("span", { cls: "bn-add-child" });
      try {
        (0, obsidian.setIcon)(btn, "plus");
      } catch (e) {
        /* decorative */
      }
      const hostRef = this;
      btn.addEventListener("click", function (ev) {
        if (ev.button !== undefined && ev.button !== 0) return;
        ev.stopPropagation();
        ev.preventDefault();
        const p = hostRef.__btnPath.get(this);
        if (p) void hostRef.create(p);
      });
      item.__bnAddBtn = btn;
    }
    // tooltip only touched when the language label actually changes
    const label = this.t("newChild");
    if (btn.__bnLabel !== label) {
      btn.__bnLabel = label;
      if (typeof btn.setAttribute === "function") {
        btn.setAttribute("aria-label", label);
        btn.setAttribute("data-tooltip-position", "bottom");
        btn.setAttribute("title", label);
      }
    }
    // keep the target path fresh across renames/re-renders
    if (!this.__btnPath) this.__btnPath = new Map();
    if (this.__btnPath.get(btn) !== file.path) this.__btnPath.set(btn, file.path);
  }
  // ---- feature: item icons (simplified Iconic) --------------------------------
  extraIconOf(path) {
    return this.settings.icons &&
      typeof this.settings.icons[path] === "string" &&
      this.settings.icons[path] !== ""
      ? this.settings.icons[path]
      : null;
  }
  async setExtraIcon(file, emoji) {
    const icons = Object.assign({}, this.settings.icons || {});
    if (emoji) icons[file.path] = emoji;
    else delete icons[file.path];
    this.settings.icons = icons;
    await this.saveSettings();
    this.decorate();
    this.refreshChildrenBlocks();
  }
  decorateItemIcon(view, item) {
    const selfEl = item.selfEl;
    if (!selfEl || typeof selfEl.createEl !== "function") return;
    const icon = this.extraIconOf(item.file.path);
    let iconEl = item.__bnIconEl;
    if (iconEl && iconEl.isConnected === false) iconEl = item.__bnIconEl = null;
    if (!icon) {
      if (iconEl) {
        if (typeof iconEl.remove === "function") iconEl.remove();
        item.__bnIconEl = null;
      }
      return;
    }
    if (!iconEl) {
      this.__clearOrphans(selfEl, ".bn-item-icon", item, "__bnIconEl");
      iconEl = selfEl.createEl("span", { cls: "bn-item-icon" });
      const content =
        selfEl.querySelector(".nav-file-title-content") ||
        selfEl.querySelector(".nav-folder-title-content");
      if (content && typeof selfEl.insertBefore === "function")
        selfEl.insertBefore(iconEl, content);
      item.__bnIconEl = iconEl;
      iconEl.__bnIcon = null;
    }
    if (iconEl.__bnIcon !== icon) {
      this.__applyIcon(iconEl, icon, item.file instanceof obsidian.TFolder);
      iconEl.__bnIcon = icon;
    }
  }
  // Alias display: replace the row's file-name text with the first frontmatter
  // alias (restore the real name when the toggle goes off).
  decorateAlias(item) {
    const selfEl = item.selfEl;
    if (!selfEl || typeof selfEl.querySelector !== "function") return;
    if (!(item.file instanceof obsidian.TFile)) return;
    const content = selfEl.querySelector(".nav-file-title-content");
    if (!content) return;
    let alias = null;
    if (this.settings.showAliases) {
      try {
        const cache =
          this.app.metadataCache && this.app.metadataCache.getFileCache
            ? this.app.metadataCache.getFileCache(item.file)
            : null;
        const a = cache && cache.frontmatter ? cache.frontmatter.aliases : null;
        alias = typeof a === "string" ? a : Array.isArray(a) && a.length ? String(a[0]) : null;
      } catch (e) {
        alias = null;
      }
    }
    const current =
      typeof content.setText === "function" || content.text !== undefined
        ? content.text !== undefined
          ? content.text
          : content.textContent
        : content.textContent;
    if (alias && alias !== item.file.name) {
      if (content.__bnRealName === undefined)
        content.__bnRealName = current !== undefined ? current : item.file.name;
      if (current === content.__bnRealName || current === content.__bnAlias) {
        content.__bnAlias = alias;
        if (typeof content.setText === "function") content.setText(alias);
        else content.textContent = alias;
      }
    } else if (content.__bnAlias && current === content.__bnAlias) {
      const restore = content.__bnRealName || item.file.name;
      content.__bnAlias = null;
      if (typeof content.setText === "function") content.setText(restore);
      else content.textContent = restore;
    }
  }
  openIconPicker(file) {
    const modal = new IconPickerModal(this.app, this, file);
    modal.open();
    return modal;
  }
  // ---- feature: folder child counts -------------------------------------------
  updateCounts(view) {
    if (!view || !view.fileItems) return;
    for (const item of Object.values(view.fileItems)) {
      const file = item && item.file;
      if (!(file instanceof obsidian.TFolder)) continue;
      if (typeof file.isRoot === "function" && file.isRoot()) continue;
      this.decorateCount(item);
    }
  }
  decorateCount(item) {
    if (!this.settings.showCounts) {
      this.__removeBadge(item);
      return;
    }
    let badge = item.__bnBadgeEl;
    if (badge && badge.isConnected === false) badge = item.__bnBadgeEl = null;
    let n;
    if (badge && badge.__bnCount !== undefined && !this.__countsDirty) {
      n = badge.__bnCount;
    } else {
      n = this.__folderInfo(item.file).visible;
    }
    if (n <= 0) {
      this.__removeBadge(item);
      return;
    }
    if (!badge) {
      this.__clearOrphans(item.selfEl, ".bn-count", item, "__bnBadgeEl");
      badge = item.selfEl.createEl("span", { cls: "bn-count", text: String(n) });
      item.__bnBadgeEl = badge;
    } else if (badge.__bnCount !== n) {
      if (typeof badge.setText === "function") badge.setText(String(n));
      else badge.textContent = String(n);
    }
    badge.__bnCount = n;
  }
  __removeBadge(item) {
    const badge = item.__bnBadgeEl;
    if (badge && typeof badge.remove === "function") badge.remove();
    item.__bnBadgeEl = null;
  }
  refreshCounts() {
    const __t = Date.now();
    this.__countsDirty = true;
    for (const view of Array.from(this.views.keys())) this.updateCounts(view);
    this.__countsDirty = false;
    if (this.__traceMark) this.__traceMark("host.refreshCounts(计数)", Date.now() - __t);
  }
  __pruneBtnPath() {
    if (!this.__btnPath || !this.__btnPath.size) return;
    for (const key of Array.from(this.__btnPath.keys())) {
      if (key.isConnected === false) this.__btnPath.delete(key);
    }
  }
  // Remove decoration spans left in the row DOM by item objects that were
  // discarded and recreated (virtualization reuses the DOM, not the object).
  __clearOrphans(selfEl, selector, item, refKey) {
    if (!selfEl || typeof selfEl.querySelectorAll !== "function") return;
    try {
      for (const el of selfEl.querySelectorAll(selector)) {
        if (typeof el.remove === "function") el.remove();
        if (this.__btnPath && this.__btnPath.has(el)) this.__btnPath.delete(el);
      }
    } catch (e) {
      /* non-fatal */
    }
    if (item) item[refKey] = null;
  }
  hiddenEntriesOf(folder) {
    const home = homeOf(this.files, folder.path);
    return function (child) {
      return !!(home && child.path === home.path);
    };
  }
  visibleChildrenOf(folder) {
    const hidden = this.hiddenEntriesOf(folder);
    const hideActive = this.hideRules().length > 0 && !this.settings.showHidden;
    const out = [];
    for (const child of folder.children) {
      if (!(child instanceof obsidian.TFile) && !(child instanceof obsidian.TFolder)) continue;
      if (hidden(child)) continue;
      if (this.isSystemNote(child.path)) continue;
      if (hideActive && this.isHidden(child)) continue;
      out.push(child);
    }
    return out;
  }
  orderedChildrenOf(folderPath) {
    const folder = this.app.vault.getAbstractFileByPath(folderPath || "/");
    if (!(folder instanceof obsidian.TFolder)) return [];
    const items = this.visibleChildrenOf(folder).slice();
    if (!this.collator) this.collator = new Intl.Collator(undefined, { numeric: true });
    const collator = this.collator;
    items.sort((a, b) => {
      const af = a instanceof obsidian.TFolder,
        bf = b instanceof obsidian.TFolder;
      if (af !== bf) return af ? -1 : 1;
      const r = collator.compare(a.name, b.name);
      return r !== 0 ? r : a.name < b.name ? -1 : 1;
    });
    let saved;
    try {
      saved = this.order?.store ? this.order.store.get(folderKey(folder)) : undefined;
    } catch (e) {
      saved = undefined;
    }
    if (!Array.isArray(saved)) return items;
    const byName = new Map(items.map((f) => [f.name, f]));
    const out = [];
    for (const name of mergedOrder(saved, items.map((f) => f.name))) {
      const item = byName.get(name);
      if (item !== undefined) out.push(item);
    }
    return this.arrangeFiles(folderPath, out);
  }

  // ---- feature: per-folder sort mode + hide rules ------------------------------
  sortModeFor(folderPath) {
    const key = folderPath === "" ? "/" : folderPath;
    const m = this.settings.folderSortModes ? this.settings.folderSortModes[key] : undefined;
    return m === "name" || m === "mtime" || m === "ctime" ? m : "manual";
  }
  __arrangeNeeded(folderPath) {
    return this.sortModeFor(folderPath) !== "manual";
  }
  __timeKey(file, mode) {
    if (file instanceof obsidian.TFile)
      return (file.stat && (mode === "mtime" ? file.stat.mtime : file.stat.ctime)) || 0;
    if (file instanceof obsidian.TFolder) {
      const home = homeOf(this.files, file.path);
      if (home) {
        const t = this.app.vault.getAbstractFileByPath(home.path);
        if (t instanceof obsidian.TFile && t.stat)
          return (mode === "mtime" ? t.stat.mtime : t.stat.ctime) || 0;
      }
      return -1; // folders without a home sink in recency sorts
    }
    return -1;
  }
  // Applies the folder's sort mode. Manual mode returns the incoming order
  // untouched (the saved order stays authoritative).
  arrangeFiles(folderPath, files) {
    if (!this.__arrangeNeeded(folderPath)) return files;
    const mode = this.sortModeFor(folderPath);
    const out = files.slice();
    if (!this.collator) this.collator = new Intl.Collator(undefined, { numeric: true });
    const collator = this.collator;
    if (mode === "name") {
      out.sort((a, b) => {
        const af = a instanceof obsidian.TFolder,
          bf = b instanceof obsidian.TFolder;
        if (af !== bf) return af ? -1 : 1;
        const r = collator.compare(a.name, b.name);
        return r !== 0 ? r : a.name < b.name ? -1 : 1;
      });
    } else if (mode === "mtime" || mode === "ctime") {
      out.sort((a, b) => {
        const d = this.__timeKey(b, mode) - this.__timeKey(a, mode);
        if (d !== 0) return d;
        const r = collator.compare(a.name, b.name);
        return r !== 0 ? r : a.name < b.name ? -1 : 1;
      });
    }
    return out;
  }
  arrangeExplorerItems(folderPath, items) {
    let out = items;
    // the config note is always hidden, regardless of the show-hidden toggle
    out = out.filter((it) => it && it.file && !this.isSystemNote(it.file.path));
    // hide rules apply in every mode (unless the user toggled "show hidden")
    if (this.hideRules().length && !this.settings.showHidden) {
      out = out.filter((it) => it && it.file && !this.isHidden(it.file));
    }
    if (this.__arrangeNeeded(folderPath)) {
      const byPath = new Map(out.map((it) => [it.file.path, it]));
      const arranged = this.arrangeFiles(
        folderPath,
        out.map(function (it) {
          return it.file;
        })
      );
      const reordered = [];
      for (const file of arranged) {
        const it = byPath.get(file.path);
        if (it !== undefined) reordered.push(it);
      }
      out = reordered;
    }
    return out;
  }
  async setSortMode(folderPath, mode) {
    const key = folderPath === "" ? "/" : folderPath;
    const modes = Object.assign({}, this.settings.folderSortModes || {});
    if (mode === "manual") delete modes[key];
    else if (mode === "name" || mode === "mtime" || mode === "ctime") modes[key] = mode;
    this.settings.folderSortModes = modes;
    await this.saveSettings();
    this.refresh();
    this.refreshChildrenBlocks();
  }

  // ---- feature: hide rules (simplified Hide Folders) ----------------------------
  hideRules() {
    return Array.isArray(this.settings.hideRules)
      ? this.settings.hideRules
          .filter(function (x) {
            return typeof x === "string" && x.trim() !== "";
          })
          .map(function (x) {
            return x.trim();
          })
      : [];
  }
  // The plugin's own config note (current + legacy names) is a system note:
  // always hidden from the explorer, the child list and the counts.
  isSystemNote(path) {
    if (path === CONFIG_NOTE) return true;
    return LEGACY_CONFIG_NOTES.includes(path);
  }
  isHidden(file) {
    if (this.settings.showHidden) return false;
    if (!(file instanceof obsidian.TFolder) && !(file instanceof obsidian.TFile)) return false;
    const rules = this.hideRules();
    if (!rules.length) return false;
    const path = file.path,
      name = file.name;
    for (const rule of rules) {
      if (rule.includes("/")) {
        // path rule: the item itself or anything inside its subtree
        if (path === rule || path.startsWith(rule + "/")) return true;
      } else if (
        rule.toLowerCase() === String(name).toLowerCase() &&
        // name rule: any folder with that name (Hide Folders semantics),
        // plus top-level files (their paths contain no slash either)
        (file instanceof obsidian.TFolder || parentOf(path) === "")
      ) {
        return true;
      }
    }
    return false;
  }
  async addHideRuleFor(file) {
    try {
      const rules = this.settings.hideRules || [];
      if (!rules.includes(file.path)) {
        this.settings.hideRules = rules.concat([file.path]);
        await this.saveSettings();
      }
      this.refresh();
      this.refreshChildrenBlocks();
    } catch (e) {
      console.error("[beautify] failed to add a hide rule:", e);
    }
  }
  // v2.11.0: the context menu could only ever ADD a hide rule; once hidden,
  // the only way back was hand-editing the rules textarea in settings. These
  // two power the "Unhide this" menu item on revealed items (eye button on).
  // hideRulesFor deliberately ignores showHidden: with the reveal on, an item
  // is visible yet still ruled hidden, and that is exactly when the menu
  // should offer to lift the rule. Matching mirrors isHidden exactly.
  hideRulesFor(file) {
    if (!(file instanceof obsidian.TFolder) && !(file instanceof obsidian.TFile)) return [];
    const path = file.path,
      name = file.name;
    return this.hideRules().filter(function (rule) {
      if (rule.includes("/")) {
        // path rule: hides the item itself or anything inside its subtree
        return path === rule || path.startsWith(rule + "/");
      }
      return (
        rule.toLowerCase() === String(name).toLowerCase() &&
        // name rule: any folder with that name, plus top-level files
        (file instanceof obsidian.TFolder || parentOf(path) === "")
      );
    });
  }
  async removeHideRulesFor(file) {
    try {
      const doomed = new Set(this.hideRulesFor(file));
      if (!doomed.size) return;
      this.settings.hideRules = (this.settings.hideRules || []).filter(function (x) {
        return !doomed.has(x);
      });
      await this.saveSettings();
      new obsidian.Notice(
        this.isZh() ? "已取消隐藏:" + file.name : "Unhidden: " + file.name,
        4000
      );
      this.refresh();
      this.refreshChildrenBlocks();
    } catch (e) {
      console.error("[beautify] failed to remove hide rules:", e);
    }
  }
  async toggleFavorite(path) {
    const f = (this.settings.favorites || []).slice();
    const i = f.indexOf(path);
    if (i >= 0) f.splice(i, 1);
    else f.push(path);
    this.settings.favorites = f;
    await this.saveSettings();
    this.decorate();
    this.renderQuickAccessAll();
  }
  // Auto-assign a random lucide icon to freshly created markdown notes.
  // ---- v2.10.4 ①: adopt external changes to the config note --------------------
  // The plugin used to read Beautify.md exactly once at startup; anything that
  // changed the note afterwards (remotely-save pulling the other machine's
  // state, a hand edit) never entered memory, and the next local slot write
  // flushed the stale memory over it (the dual-machine icon incident).
  __onConfigNoteModify(file) {
    try {
      if (!this.alive) return;
      if (!file || file.path !== CONFIG_NOTE) return;
      // Coalesce bursts (sync tools may rewrite the note several times).
      if (this.__cfgAdoptTimer) return;
      this.__cfgAdoptTimer = setTimeout(() => {
        this.__cfgAdoptTimer = null;
        void this.__adoptExternalConfig();
      }, 400);
    } catch (e) {
      /* best-effort */
    }
  }
  async __adoptExternalConfig() {
    try {
      if (!this.alive) return;
      const cfg = this.config;
      const file = this.app.vault.getFileByPath(CONFIG_NOTE);
      if (!(file instanceof obsidian.TFile)) return;
      const raw = await this.app.vault.cachedRead(file);
      const parsed = parseJsonBlock(raw);
      if (!parsed || typeof parsed !== "object") {
        console.warn(
          "[beautify] config note changed on disk but has no valid json block; keeping in-memory state"
        );
        return;
      }
      if (cfg.lastWritten === raw) return; // echo of our own write
      // Slot-level merge: slots we mutated but haven't flushed win over the
      // external state; everything else is adopted wholesale.
      const dirtySlots = cfg.dirtySlots instanceof Set ? Array.from(cfg.dirtySlots) : [];
      for (const k of dirtySlots) parsed[k] = cfg.data ? cfg.data[k] : undefined;
      const hostChanged = JSON.stringify(parsed.host) !== JSON.stringify(cfg.data.host);
      const orderChanged =
        JSON.stringify(parsed.orderEditor) !== JSON.stringify(cfg.data.orderEditor);
      cfg.data = parsed;
      cfg.lastWritten = null; // memory and disk differ until the merged flush lands
      if (dirtySlots.length) {
        cfg.dirty = true;
        void enqueueConfigFlush(cfg);
      }
      if (hostChanged) await this.loadHostSettings(); // rebind this.settings
      if (
        orderChanged &&
        this.order &&
        parsed.orderEditor &&
        parsed.orderEditor.index &&
        typeof parsed.orderEditor.index === "object"
      ) {
        try {
          await this.order.load(); // steady-shape reload only (guarded above)
          // complete a v2→v3 conversion that arrived from outside, same as
          // onload does: rebind the host slot so its legacy flat icons leave
          if (this.order.store && this.order.store.migratedToTree) {
            void this.saveSettings();
          }
        } catch (e) {
          console.error("[beautify] failed to reload order data after external change:", e);
        }
      }
      if (hostChanged || orderChanged) {
        this.refresh();
        this.refreshCounts();
        this.refreshChildrenBlocks();
      }
      console.log("[beautify] adopted an external config note change (sync or hand edit)");
    } catch (e) {
      console.error("[beautify] failed to adopt external config change:", e);
    }
  }
  // ---- v2.10.4 ②: skip auto icons for sync/rename create storms ----------------
  // remotely-save materialises a cross-machine rename as delete+create; the
  // old hook stamped random icons on every "new" file, clobbering real icon
  // keys in bulk (666 files at once in the incident). Collect creates in a
  // fixed 1s window: a handful is a human, a flood is a sync — only humans
  // get auto icons.
  __collectAutoIconCreate(file) {
    try {
      if (!this.settings.autoIcon) return;
      if (!(file instanceof obsidian.TFile) || !/\.md$/i.test(file.name || "")) return;
      if (!this.__autoIconPending) this.__autoIconPending = [];
      this.__autoIconPending.push(file);
      if (!this.__autoIconWindow) {
        this.__autoIconWindow = setTimeout(() => {
          this.__autoIconWindow = null;
          this.__drainAutoIconPending();
        }, 1000);
      }
    } catch (e) {
      /* never disturb vault events */
    }
  }
  __drainAutoIconPending() {
    const pending = this.__autoIconPending || [];
    this.__autoIconPending = [];
    if (!pending.length) return;
    if (pending.length >= 5) {
      console.log(
        "[beautify] auto icon skipped for " +
          pending.length +
          " files created within 1s (looks like a sync/rename storm, not a human)"
      );
      return;
    }
    for (const f of pending) {
      try {
        if (f && f.path && this.app.vault.getFileByPath(f.path))
          this.assignAutoIcon(f);
      } catch (e) {
        /* per-file best-effort */
      }
    }
  }
  assignAutoIcon(file) {
    try {
      if (!this.settings.autoIcon) return;
      if (!(file instanceof obsidian.TFile) || !/\.md$/i.test(file.name || "")) return;
      if (this.settings.icons && this.settings.icons[file.path]) return; // already set
      if (this.isSystemNote(file.path)) return;
      const list = emojiList();
      if (!list.length) return;
      const pick = list[Math.floor(Math.random() * list.length)].e;
      const icons = Object.assign({}, this.settings.icons || {});
      icons[file.path] = pick;
      this.settings.icons = icons;
      void this.saveSettings().then(() => {
        this.decorate();
        this.refreshChildrenBlocks();
      });
    } catch (e) {
      console.error("[beautify] failed to auto-assign an icon:", e);
    }
  }
  async toggleShowHidden() {
    this.settings.showHidden = !this.settings.showHidden;
    await this.saveSettings();
    this.refresh();
    this.refreshChildrenBlocks();
    this.updateRibbonIcon();
    new obsidian.Notice(
      this.settings.showHidden
        ? this.isZh()
          ? "已显示被隐藏的文件"
          : "Hidden files shown"
        : this.isZh()
          ? "已按隐藏规则隐藏文件"
          : "Hidden files hidden",
      1500
    );
  }
  updateRibbonIcon() {
    const el = this.__ribbonEl;
    if (!el) return;
    try {
      (0, obsidian.setIcon)(el, this.settings.showHidden ? "eye" : "eye-off");
      if (typeof el.setAttribute === "function")
        el.setAttribute(
          "aria-label",
          this.isZh() ? "显示/隐藏 被隐藏的文件" : "Toggle hidden files"
        );
    } catch (e) {
      /* ribbon is decorative */
    }
  }
  // ---- link-creates-child -------------------------------------------------------
  // The active HOME note is remembered so unresolved [[links]] clicked inside
  // it create their notes inside that folder.
  trackActiveHome() {
    if (!this.alive) return;
    let activeFile = null,
      activeHomeFolder = null;
    let view = null;
    try {
      view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    } catch (e) {
      view = null;
    }
    const file = view && view.file;
    if (view && file instanceof obsidian.TFile && /\.md$/i.test(file.name)) {
      activeFile = file.path;
      activeHomeFolder = pageFolder(this.files, file.path) || null;
    }
    this.__activeHome = activeFile ? { path: activeFile, folder: activeHomeFolder } : null;
  }
  // A plain-left-click on an unresolved [[link]] inside the active home note
  // creates the note in that folder: Obsidian creates it at the default
  // location first; we recognise the case and move it in.
  maybeMoveLinkedChild(file) {
    try {
      if (!this.settings.linkCreatesChild) return;
      if (!(file instanceof obsidian.TFile) || !/\.md$/i.test(file.name || "")) return;
      const home = this.__activeHome;
      if (!home || !home.folder) return;
      if (parentOf(file.path) === home.folder) return; // already inside
      // Only notes Obsidian creates at the VAULT ROOT — never touch files
      // sync writes into their real folders.
      if (parentOf(file.path) !== "") return;
      const cache =
        this.app.metadataCache && this.app.metadataCache.unresolvedLinks
          ? this.app.metadataCache.unresolvedLinks[home.path]
          : null;
      if (!cache || typeof cache !== "object") return;
      const base = file.basename || file.name.replace(/\.md$/i, "");
      if (!Object.prototype.hasOwnProperty.call(cache, base)) return;
      const dest = home.folder + "/" + file.name;
      if (this.app.vault.getAbstractFileByPath(dest)) return; // never clobber
      void this.app.fileManager
        .renameFile(file, dest)
        .then(() => {
          this.refresh();
        })
        .catch((e) => {
          console.error("[beautify] failed to move the linked child note:", e);
        });
    } catch (e) {
      console.error("[beautify] link-creates-child failed:", e);
    }
  }

  // ---- feature: child-page list block (```bn-children```) ----------------------
  parseChildrenOptions(source) {
    const opts = { recursive: false, time: false, grid: false, kind: "all" };
    for (const line of String(source || "").split("\n")) {
      const s = line.trim().toLowerCase();
      if (!s) continue;
      if (s === "递归" || s === "recursive") opts.recursive = true;
      else if (s === "时间" || s === "time") opts.time = true;
      else if (s === "网格" || s === "grid") opts.grid = true;
      else if (s === "类型:文件夹" || s === "folders" || s === "folder") opts.kind = "folders";
      else if (s === "类型:笔记" || s === "files" || s === "notes") opts.kind = "files";
    }
    return opts;
  }
  handleChildrenBlock(source, el, ctx) {
    try {
      el.addClass("bn-children");
      const path = ctx && typeof ctx.sourcePath === "string" ? ctx.sourcePath : "";
      const folder = pageFolder(this.files, path);
      const entry = { folder, opts: this.parseChildrenOptions(source) };
      this.childrenBlocks.set(el, entry);
      this.renderChildrenBlock(el, entry);
    } catch (e) {
      console.error("[beautify] failed to render the bn-children block:", e);
    }
  }
  __mtimeOf(file) {
    try {
      if (file instanceof obsidian.TFile) return (file.stat && file.stat.mtime) || null;
      if (file instanceof obsidian.TFolder) {
        const home = homeOf(this.files, file.path);
        if (home) {
          const t = this.app.vault.getAbstractFileByPath(home.path);
          if (t instanceof obsidian.TFile && t.stat) return t.stat.mtime || null;
        }
      }
    } catch (e) {
      /* no time */
    }
    return null;
  }
  __mtimeText(file) {
    const m = this.__mtimeOf(file);
    if (!m) return "";
    const d = new Date(m);
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  collectDescendants(folderPath, depth, out) {
    const children = this.orderedChildrenOf(folderPath);
    for (const child of children) {
      out.push({ file: child, depth });
      if (child instanceof obsidian.TFolder) this.collectDescendants(child.path, depth + 1, out);
    }
  }
  renderChildrenBlock(el, entry) {
    el.empty();
    const zh = this.isZh();
    const folder = entry && entry.folder;
    const opts =
      (entry && entry.opts) || { recursive: false, time: false, grid: false, kind: "all" };
    if (typeof el.toggleClass === "function") el.toggleClass("bn-children-grid", !!opts.grid);
    if (!folder || !this.service) {
      el.createDiv({
        cls: "bn-children-empty",
        text: zh
          ? "bn-children 块需要放在首页笔记(目录/同名.md)中才会渲染子页面列表。"
          : "The bn-children block only renders inside a home note (Folder/Folder.md).",
      });
      return;
    }
    let list;
    if (opts.recursive) {
      list = [];
      this.collectDescendants(folder, 0, list);
    } else {
      list = this.orderedChildrenOf(folder).map(function (f) {
        return { file: f, depth: 0 };
      });
    }
    if (opts.kind === "folders")
      list = list.filter(function (e) {
        return e.file instanceof obsidian.TFolder;
      });
    else if (opts.kind === "files")
      list = list.filter(function (e) {
        return e.file instanceof obsidian.TFile;
      });
    el.createDiv({
      cls: "bn-children-header",
      text: (zh ? "子页面" : "Sub-pages") + " · " + list.length,
    });
    for (const item of list) this.renderChildRow(el, item.file, opts, item.depth);
    const add = el.createDiv({
      cls: "bn-child-add",
      text: zh ? "＋ 新建子页面" : "＋ New sub-page",
    });
    add.addEventListener("click", () => {
      if (this.service) void this.create(folder);
    });
  }
  renderChildRow(el, child, opts, depth) {
    const isFolder = child instanceof obsidian.TFolder;
    const row = el.createDiv({ cls: "bn-child-row" + (isFolder ? " is-folder" : "") });
    if (depth) {
      try {
        row.style.paddingLeft = depth * 18 + "px";
      } catch (e) {
        /* style optional */
      }
    }
    const icon = row.createEl("span", { cls: "bn-child-icon" });
    this.__applyIcon(icon, this.extraIconOf(child.path), isFolder);
    row.createEl("span", {
      cls: "bn-child-label",
      text: isFolder ? child.name : child.basename || child.name,
    });
    if (opts && opts.time) {
      const t = this.__mtimeText(child);
      if (t) row.createEl("span", { cls: "bn-child-time", text: t });
    }
    row.addEventListener("click", (ev) => {
      const newTab = ev.ctrlKey || ev.metaKey;
      if (isFolder) {
        void this.openFolder(child.path, newTab);
        return;
      }
      const leaf = this.app.workspace.getLeaf(newTab ? "tab" : false);
      void leaf.openFile(child);
    });
  }
  // Renders an extra icon: emoji as text, ASCII names as lucide icons.
  __applyIcon(iconEl, icon, isFolder) {
    if (icon && /[^\x00-\x7F]/.test(icon)) {
      if (typeof iconEl.setText === "function") iconEl.setText(icon);
      else iconEl.textContent = icon;
      return;
    }
    if (icon) {
      if (typeof iconEl.setText === "function") iconEl.setText("");
      try {
        (0, obsidian.setIcon)(iconEl, icon);
      } catch (e) {
        /* unknown name */
      }
      return;
    }
    try {
      (0, obsidian.setIcon)(iconEl, isFolder ? "folder" : "file-text");
    } catch (e) {
      /* icon is decorative */
    }
  }
  refreshChildrenBlocks() {
    const __t = Date.now();
    for (const [el, entry] of Array.from(this.childrenBlocks)) {
      if (!el || el.isConnected === false) {
        this.childrenBlocks.delete(el);
        continue;
      }
      try {
        this.renderChildrenBlock(el, entry);
      } catch (e) {
        console.error("[beautify] failed to refresh a bn-children block:", e);
      }
    }
    if (this.__traceMark) this.__traceMark("host.childrenBlocks(列表块)", Date.now() - __t);
  }
  // ---- v1.2.0: breadcrumb hover → child notes menu -------------------------------
  // One delegated mouseover drives everything: hover a segment → show its
  // folder's menu; hover INTO the menu → keep it; hover anywhere else → hide
  // after a grace period. Click/Esc/scroll hide it immediately.
  __onCrumbMouseOver(ev) {
    try {
      if (this.__crumbHideTimer) {
        clearTimeout(this.__crumbHideTimer);
        this.__crumbHideTimer = null;
      }
      if (!this.alive || this.settings.breadcrumbChildren === false) {
        // never strand an open menu behind a cleared hide timer
        if (this.__crumbMenu) this.__crumbMenuRemove();
        return;
      }
      const target = ev.target;
      if (!target || typeof target.closest !== "function") return;
      if (this.__crumbMenu && this.__crumbMenu.contains(target)) return; // inside — keep open
      const seg = target.closest(".view-header-breadcrumb");
      if (!seg || !seg.parentElement) {
        this.__crumbMenuScheduleHide();
        return;
      }
      const path = bnCrumbPathOf(seg);
      const folder =
        path && this.app && this.app.vault
          ? this.app.vault.getAbstractFileByPath(path)
          : null;
      if (!(folder instanceof obsidian.TFolder)) {
        // external-file breadcrumbs or a vanished folder — not ours to list
        this.__crumbMenuScheduleHide();
        return;
      }
      if (
        this.__crumbMenu &&
        this.__crumbMenu.__bnPath === path &&
        this.__crumbMenu.isConnected !== false
      ) {
        return; // already showing this folder
      }
      this.__crumbMenuShow(seg, path);
    } catch (e) {
      /* hover is best-effort */
    }
  }
  __crumbMenuShow(seg, path) {
    this.__crumbMenuRemove();
    const menu = document.body.createEl("div", { cls: "bn-crumb-menu" });
    menu.__bnPath = path;
    try {
      bnRenderCrumbMenu(this, menu, path);
    } catch (e) {
      // a render failure must not leave an empty box pinned to the screen
      try {
        menu.remove();
      } catch (e2) {
        /* already gone */
      }
      console.error("[beautify] failed to render the breadcrumb menu:", e);
      return;
    }
    // any click inside (a row) opens the note — hide once the click landed
    menu.addEventListener("click", () => this.__crumbMenuRemove());
    // position after append (size is knowable), clamped into the viewport;
    // flip above the header when the menu would run past the bottom
    try {
      const r = seg.getBoundingClientRect();
      const w = menu.offsetWidth || 200;
      const h = menu.offsetHeight || 120;
      const vw = window.innerWidth || 1200;
      const vh = window.innerHeight || 800;
      let left = Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8));
      let top = r.bottom + 6;
      if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
      menu.style.left = left + "px";
      menu.style.top = top + "px";
    } catch (e) {
      /* position is decorative; visibility beats precision */
    }
    this.__crumbMenu = menu;
  }
  __crumbMenuScheduleHide() {
    if (this.__crumbHideTimer || !this.__crumbMenu) return;
    this.__crumbHideTimer = setTimeout(() => {
      this.__crumbHideTimer = null;
      this.__crumbMenuRemove();
    }, 200);
  }
  __crumbMenuRemove() {
    if (this.__crumbHideTimer) {
      clearTimeout(this.__crumbHideTimer);
      this.__crumbHideTimer = null;
    }
    if (this.__crumbMenu) {
      try {
        if (typeof this.__crumbMenu.remove === "function") this.__crumbMenu.remove();
        else if (this.__crumbMenu.parentNode) this.__crumbMenu.parentNode.removeChild(this.__crumbMenu);
      } catch (e) {
        /* already gone */
      }
      this.__crumbMenu = null;
    }
  }

  // ---- feature: child note template ---------------------------------------------
  templateApplier() {
    const host = this;
    return {
      // Returns the template path to apply to this new note, or null.
      applies: function (path) {
        return host.templateFor(path);
      },
      readFor: function (path, templatePath) {
        return host.readTemplateFor(path, templatePath);
      },
      isPristine: function (path, result) {
        return host.injectedTemplates.get(path) === result;
      },
    };
  }
  __isHomePath(path) {
    const parent = parentOf(path);
    if (!parent) return false;
    return (baseOf(parent) + ".md").toLowerCase() === baseOf(path).toLowerCase();
  }
  templateFor(path) {
    if (!/\.md$/i.test(path)) return null;
    const parent = parentOf(path);
    if (!parent) return null; // vault-root files are not children of a page
    let tp = this.__isHomePath(path)
      ? this.settings.homeTemplatePath
      : this.settings.childTemplatePath;
    tp = String(tp || "").trim();
    return tp || null;
  }
  async readTemplateFor(path, templatePath) {
    try {
      const tpl = (0, obsidian.normalizePath)(String(templatePath));
      const file = this.app.vault.getFileByPath(tpl);
      if (!(file instanceof obsidian.TFile)) return null;
      const raw = await this.app.vault.cachedRead(file);
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const content = raw
        .replace(/\{\{title\}\}/gi, baseOf(path).replace(/\.md$/i, ""))
        .replace(/\{\{folder\}\}/gi, baseOf(parentOf(path)))
        .replace(
          /\{\{date\}\}/gi,
          now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate())
        )
        .replace(/\{\{time\}\}/gi, pad(now.getHours()) + ":" + pad(now.getMinutes()));
      this.injectedTemplates.set(path, content);
      // keep the map bounded (undo window is short; old entries are stale)
      if (this.injectedTemplates.size > 50) {
        const oldest = this.injectedTemplates.keys().next().value;
        if (oldest !== undefined) this.injectedTemplates.delete(oldest);
      }
      return content;
    } catch (e) {
      console.error("[beautify] could not read the template:", e);
      return null;
    }
  }

  // ---- self-diagnostics -----------------------------------------------------------
  // Probes the live explorer: is the order prototype patch applied, are the
  // Branch Note instance wrappers mounted, does the saved order actually
  // render? One Notice summarises it.
  __diagnose() {
    try {
      // [diag]
      __bdiag(
        "diagnose: order=" +
          (this.order ? "yes" : "null") +
          " storeKeys=" +
          (this.order ? this.order.store.keys().size : "-") +
          " patched=" +
          (this.order ? this.order.sortPatched : "-") +
          " delegated=" +
          this.delegatedViews.size
      );
    } catch (e) {}
    const problems = [];
    const views = explorerViews(this.app);
    let wrapped = 0;
    let delegated = 0;
    let orderApplied = null;
    const patched = this.order?.sortPatched === true;
    for (const view of views) {
      if (Object.hasOwn(view, "getSortedFolderItems")) wrapped++;
      if (this.delegatedViews.has(view)) delegated++;
      if (orderApplied === null && this.order) {
        try {
          const root = this.app.vault.getRoot();
          const names = (view.getSortedFolderItems(root) || [])
            .map((it) => (it && it.file ? it.file.name : "?"));
          const saved = this.order.store.get("/");
          if (Array.isArray(saved) && saved.length && names.length) {
            const visible = names.filter((n) => saved.includes(n));
            const savedVisible = saved.filter((n) => names.includes(n));
            orderApplied = JSON.stringify(visible) === JSON.stringify(savedVisible);
          } else {
            orderApplied = "no-data";
          }
        } catch (e) {
          orderApplied = "probe-failed";
        }
      }
    }
    if (!views.length) problems.push("未找到文件列表视图");
    if (views.length && !patched) problems.push("排序原型补丁未挂载");
    if (views.length && wrapped === 0) problems.push("首页层未挂到文件列表(实例补丁缺失)");
    if (views.length && delegated === 0) problems.push("文件夹点击监听为 0(点击打开首页因此失效)");
    if (orderApplied === false) problems.push("保存的排序未生效(原型补丁缺失或被遮挡)");
    let entries = 0;
    try {
      entries = this.order ? this.order.store.keys().size : 0;
    } catch (e) {
      entries = 0;
    }
    const zh = this.isZh();
    const ok = problems.length === 0;
    const lines = [
      zh
        ? "文件列表视图 " +
          views.length +
          " 个,首页层已挂 " +
          wrapped +
          " 个,点击监听 " +
          delegated +
          " 个,排序补丁" +
          (patched ? "已挂载" : "未挂载")
        : "explorer views: " +
          views.length +
          ", wrapped: " +
          wrapped +
          ", click handlers: " +
          delegated +
          ", order patch: " +
          (patched ? "on" : "off"),
      zh
        ? "排序存储 " + entries + " 条;根目录排序探测:" + (orderApplied === true ? "已应用" : orderApplied === false ? "未应用" : "无数据/未探测")
        : "store entries: " + entries + "; root order probe: " + orderApplied,
    ];
    if (problems.length) lines.push(problems.join("\n- "));
    const head =
      "Beautify v" + this.manifest.version + (zh ? " 诊断:" : " diagnostics:") + (ok ? "✅ 正常" : "⚠️ 异常");
    console.log("[beautify] " + head + "\n" + lines.join("\n"));
    // v2.5.2: a healthy startup stays SILENT — the Notice only appears when
    // the probe actually found problems
    if (!ok) new obsidian.Notice(head + "\n" + lines.join("\n"), 15000);
  }

  // ---- diagnostics: duplicate rendered images --------------------------------------
  // Reports where identical <img> elements repeat inside one view, so the
  // duplication mechanism (which container, which mode) is visible in the
  // console instead of guessing.
  __checkDuplicateImages() {
    let found = 0;
    try {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf && leaf.view;
        const contentEl = view && view.contentEl;
        if (!contentEl || typeof contentEl.querySelectorAll !== "function") continue;
        const imgs = contentEl.querySelectorAll("img");
        const groups = new Map();
        for (const img of imgs) {
          const src =
            typeof img.getAttribute === "function" ? img.getAttribute("src") || "" : "";
          const key = src || "__nosrc__";
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(img);
        }
        groups.forEach((list, src) => {
          if (list.length > 1) {
            found++;
            const chain = [];
            let node = list[0];
            for (let d = 0; d < 6 && node && node !== contentEl; d++) {
              chain.push(
                typeof node.className === "string" && node.className
                  ? node.className
                  : node.tagName || "el"
              );
              node = node.parentElement;
            }
            console.error(
              "[beautify] 重复图片 x" + list.length + " src=" + String(src).slice(0, 90),
              "\n  容器链:",
              chain.join(" < "),
              "\n  视图:",
              (view.contentEl && view.contentEl.className) || "(unknown)"
            );
          }
        });
      }
    } catch (e) {
      console.error("[beautify] duplicate-image check failed:", e);
    }
    if (found)
      new obsidian.Notice(
        "Beautify:检测到 " + found + " 处重复图片,详情已打印到控制台(⌘⌥I)",
        10000
      );
    else console.log("[beautify] duplicate-image check: clean");
    return found;
  }

  // ---- lifecycle --------------------------------------------------------------------
  async onload() {
    console.log("[beautify] v" + this.manifest.version + " loading…");
    // v2.10.11: era bump — invalidates any post-unload watchdog left by the
    // previous instance so it stops stripping THIS instance's decorations.
    globalThis.__beautifyEra = (globalThis.__beautifyEra || 0) + 1;
    await this.config.load();
    try {
      // [diag]
      const d = this.config.data || {};
      const oe = d.orderEditor || {};
      __bdiag(
        "onload: config slots=" +
          JSON.stringify(Object.keys(d)) +
          " orderEditor.index keys=" +
          (oe.index && typeof oe.index === "object" ? Object.keys(oe.index).length : String(oe.index))
      );
    } catch (e) {}
    await this.loadHostSettings();
    await this.loadBranchData();

    // 1) OrderCore first: patches FileExplorer.prototype.
    this.order = new OrderCore(this);
    try {
      await this.order.activate();
    } catch (e) {
      console.error("[beautify] failed to start the order core:", e);
      new obsidian.Notice(
        "Beautify: the order core could not start — see the console. The page layer keeps running.",
        8000
      );
      this.order = null;
    }
    // v1.3.0: a v2 (flat) orderEditor slot was rewritten as the document tree
    // by store.load — rebind the host slot too so the legacy flat icons map
    // leaves the note and the conversion completes in one launch.
    if (this.order && this.order.store && this.order.store.migratedToTree) {
      void this.saveSettings();
    }

    // 2) Branch Note layer second: wraps explorer view instances on top.
    this.startBranchNote();

    // 3) Host features.
    this.__ribbonEl = this.addRibbonIcon(
      this.settings.showHidden ? "eye" : "eye-off",
      this.t("toggleHidden"),
      () => {
        void this.toggleShowHidden();
      }
    );
    this.updateRibbonIcon();
    this.commandLabels.push({
      command: this.addCommand({
        id: "toggle-hidden",
        name: this.t("toggleHidden"),
        callback: () => {
          void this.toggleShowHidden();
        },
      }),
      key: "toggleHidden",
    });
    this.addCommand({
      id: "check-duplicate-images",
      name: this.isZh() ? "检查重复渲染的图片(诊断)" : "Check for duplicated rendered images (diagnostics)",
      callback: () => {
        const n = this.__checkDuplicateImages();
        if (!n)
          new obsidian.Notice(this.isZh() ? "未检测到重复图片" : "No duplicated images found", 4000);
      },
    });
    this.registerMarkdownCodeBlockProcessor("bn-children", (source, el, ctx) => {
      this.handleChildrenBlock(source, el, ctx);
    });
    // task view note: one ```bn-tasks-view``` block renders the dashboard
    // (工作台 / 看板 / 四象限) in reading AND live preview
    this.registerMarkdownCodeBlockProcessor("bn-tasks-view", (source, el, ctx) => {
      try {
        el.empty();
        el.__bnTvSource = String(source || "");
        this.registerTaskViewBlock(el);
        renderTasksViewBlock(this, el, source);
      } catch (e) {
        console.error("[beautify] failed to render the tasks view block:", e);
      }
    });
    // task management: reading-mode hover buttons + index upkeep
    this.registerMarkdownPostProcessor((el, ctx) => this.decorateReadingTasks(el, ctx));
    // v1.1.0: hide the inline date fields in live preview / source mode too
    // (reveal-on-cursor-line); the body class gates the reading-view spans
    this.registerEditorExtension(bnTaskDateEditorExtension(this));
    document.body.classList.toggle("bn-show-task-dates", !!this.settings.showTaskDates);
    // [] + space expansion and the floating hover button (plain Obsidian APIs)
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) =>
        this.__onTaskEditorChange(editor, info)
      )
    );
    this.registerDomEvent(document, "mouseover", (ev) => this.__onTaskEditorMouseOver(ev));
    // v1.2.0: breadcrumb hover → child notes menu (hide on click-away/Esc/
    // scroll; the same capture-scroll convention as the task hover bar)
    this.registerDomEvent(document, "mouseover", (ev) => this.__onCrumbMouseOver(ev));
    this.registerDomEvent(
      document,
      "click",
      (ev) => {
        if (
          this.__crumbMenu &&
          ev.target &&
          !(this.__crumbMenu.contains && this.__crumbMenu.contains(ev.target))
        ) {
          this.__crumbMenuRemove();
        }
      },
      true
    );
    this.registerDomEvent(
      document,
      "keydown",
      (ev) => {
        if (ev.key === "Escape") this.__crumbMenuRemove();
      },
      true
    );
    this.registerDomEvent(
      document,
      "scroll",
      (ev) => {
        // capture sees scrolls INSIDE the menu too (the list can scroll) —
        // those must not close it; everything else repositions the world
        if (
          this.__crumbMenu &&
          ev &&
          ev.target &&
          this.__crumbMenu.contains &&
          this.__crumbMenu.contains(ev.target)
        ) {
          return;
        }
        this.__crumbMenuRemove();
      },
      true
    );
    // empty home note: Backspace/Delete removes it (capture beats CM6's own handlers)
    this.registerDomEvent(document, "keydown", (ev) => this.__onEmptyHomeDeleteKey(ev), true);
    this.registerDomEvent(document, "scroll", () => this.__hideTaskFloat(), true);
    this.registerEvent(this.app.vault.on("modify", (file) => void this.__taskIndexFile(file)));
    this.registerEvent(this.app.vault.on("create", (file) => void this.__taskIndexFile(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onTaskFileDeleted(file)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.onTaskFileRenamed(file, oldPath))
    );
    this.addCommand({
      id: "open-tasks",
      name: this.isZh() ? "打开任务视图" : "Open tasks view",
      callback: () => {
        void this.openTasksNote();
      },
    });
    this.addCommand({
      id: "edit-task",
      name: this.isZh() ? "编辑光标处任务" : "Edit task under cursor",
      editorCallback: (editor, ctx) => {
        try {
          const cursor = editor.getCursor("from");
          const task = parseTaskLine(editor.getLine(cursor.line));
          if (task && ctx.file instanceof obsidian.TFile) this.openTaskEditModal(ctx.file, task);
        } catch (e) {
          /* no task at the cursor */
        }
      },
    });
    // v2.5.0: keyboard flow — toggle the task under the cursor (stamp ✅/❌)
    this.addCommand({
      id: "toggle-task",
      name: this.isZh() ? "完成/重开光标处任务" : "Toggle task under cursor",
      editorCallback: (editor, ctx) => {
        try {
          const cursor = editor.getCursor("from");
          const task = parseTaskLine(editor.getLine(cursor.line));
          if (task && ctx.file instanceof obsidian.TFile) void this.toggleTask(ctx.file, task);
        } catch (e) {
          /* no task at the cursor */
        }
      },
    });
    // per-note view mode: switch the opening note to its saved mode (v2.7.0)
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => this.onFileOpenViewMode(file))
    );
    // v2.9.0: the editor's own edit/reading toggle (top-right button, Mod+E,
    // view menu — all funnel into MarkdownView.toggleMode) also pins the
    // per-note mode; restored on unload with the other patches.
    this.__patchToggleMode();
    // host path data (icons/favorites/…) must follow renames (v2.7.1)
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.migrateHostPathsOnRename(file, oldPath))
    );
    this.registerEvent(this.app.vault.on("create", (file) => this.maybeMoveLinkedChild(file)));
    this.registerEvent(this.app.vault.on("create", (file) => this.__collectAutoIconCreate(file)));
    // v2.10.4 ①: watch the config note so external changes (sync / hand
    // edits) are adopted instead of being clobbered by the next local write.
    this.registerEvent(this.app.vault.on("modify", (file) => this.__onConfigNoteModify(file)));
    this.registerEvent(this.app.vault.on("create", () => this.refreshChildrenBlocks()));
    this.registerEvent(this.app.vault.on("delete", () => this.refreshChildrenBlocks()));
    this.registerEvent(this.app.vault.on("rename", () => this.refreshChildrenBlocks()));

    this.settingsTab = new BeautifySettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    const _this = this;
    this.app.workspace.onLayoutReady(function () {
      _this.warnAboutLegacyPlugins();
      // build the task index once the vault is settled
      if (_this.settings.enableTasks) {
        setTimeout(function () {
          void _this.__taskIndexAll();
        }, 1200);
      }
      // let the explorer settle, then probe the patch chain
      setTimeout(function () {
        try {
          // Post-mortem guard (v2.10.8): this bare timer survives unload, and
          // firing after the plugin was turned off reported ⚠️ from a dead
          // instance (order=null) — which read exactly like a failed boot.
          if (!_this.alive) {
            __bdiag("diagnose skipped — plugin already unloaded"); // [diag]
            return;
          }
          _this.__diagnose();
        } catch (e) {
          console.error("[beautify] diagnostics failed:", e);
        }
      }, 800);
    });
    console.log(
      "[beautify] onload finished: OrderCore=" +
        (this.order ? "ok" : "FAILED") +
        ", BranchNote=" +
        (this.files ? "ok" : "FAILED")
    );
    this.register(function () {
      _this.teardownBranchNote();
    });
  }
  // Remove every DOM decoration this plugin injected into file-explorer rows
  // (icons, ＋ buttons, count badges, quick-access section) and markdown views
  // (reading-view task buttons/icons; plugin-rendered code blocks fall back to
  // raw source via a forced re-render). Obsidian does not re-render these
  // surfaces reliably when a plugin is disabled, so without this sweep the
  // decorations linger in the DOM until a full app restart (v2.10.3/5).
  __sweepInjectedDom() {
    const views = new Set(this.delegatedViews || []);
    try {
      for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
        if (leaf.view && leaf.view.containerEl) views.add(leaf.view);
      }
    } catch (e) {
      /* best-effort */
    }
    for (const view of views) {
      try {
        const el = view.containerEl;
        if (!el || typeof el.querySelectorAll !== "function") continue;
        let swept = 0;
        el.querySelectorAll(".bn-add-child,.bn-item-icon,.bn-quick,.bn-count")
          .forEach(function (n) {
            if (typeof n.remove === "function") {
              n.remove();
              swept++;
            }
          });
        swept += this.__sweepCachedRows(view);
        if (swept) __bdiag("sweepInjectedDom: removed " + swept + " node(s) from one view"); // [diag]
        view.__bn_quick = null;
        view.__bnQuickSig = null;
      } catch (e) {
        /* best-effort */
      }
    }
    // Markdown views: strip post-processor decorations, then force the same
    // re-render Obsidian runs on "post-processor-change" — that event path
    // does not cover every open view, so plugin-rendered code blocks
    // (bn-children / bn-tasks-view) could otherwise stay frozen on screen.
    try {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view;
        if (!view || !view.contentEl) continue;
        view.contentEl
          .querySelectorAll(".bn-task-btn,.bn-item-icon")
          .forEach(function (n) {
            if (typeof n.remove === "function") n.remove();
          });
        if (view.previewMode && typeof view.previewMode.rerender === "function")
          view.previewMode.rerender(true);
      }
    } catch (e) {
      /* best-effort */
    }
  }
  async onunload() {
    __bdiag("onunload v" + (this.manifest ? this.manifest.version : "?")); // [diag]
    // Stop every decoration path immediately, even if a later step throws
    // (teardownBranchNote also sets this, but only once it gets there).
    this.alive = false;
    // Sweep injected decorations first — nothing later in the teardown
    // re-renders these surfaces, so they must be removed explicitly.
    this.__sweepInjectedDom();
    // Instance layer (Branch Note) first, order core second — reverse of load.
    // v2.10.6: guarded — a throw inside teardown must not skip the remaining
    // unload work (patch restore, timers, config/order flush, final sweep).
    try {
      this.teardownBranchNote();
    } catch (e) {
      console.error("[beautify] explorer teardown failed:", e);
    }
    this.__unpatchToggleMode();
    for (const id of this.__viewModeTimers) clearTimeout(id);
    this.__viewModeTimers.clear();
    if (this.__cfgAdoptTimer) {
      clearTimeout(this.__cfgAdoptTimer);
      this.__cfgAdoptTimer = null;
    }
    if (this.__autoIconWindow) {
      clearTimeout(this.__autoIconWindow);
      this.__autoIconWindow = null;
    }
    this.__autoIconPending = [];
    this.childrenBlocks.clear();
    this.injectedTemplates.clear();
    this.taskViewBlocks.clear();
    if (this.__traceTimer) {
      clearTimeout(this.__traceTimer);
      this.__traceTimer = null;
    }
    this.__trace = null;
    this.__removeTaskFloat();
    // v1.2.0: the breadcrumb hover menu lives in document.body — remove it
    this.__crumbMenuRemove();
    // v1.1.0: drop the reading-view date-fields visibility class (any spans
    // already rendered become inert without the plugin's CSS once disabled)
    document.body.classList.remove("bn-show-task-dates");
    this.__taskIndex.clear();
    if (this.__taskRefreshTimer) {
      clearTimeout(this.__taskRefreshTimer);
      this.__taskRefreshTimer = null;
    }
    try {
      await this.config.flush();
    } catch (e) {
      console.error("[beautify] failed to flush the config note:", e);
    }
    if (this.order) {
      try {
        await this.order.store.flush();
      } catch (e) {
        console.error("[beautify] failed to flush the order store:", e);
      }
      this.order.unload();
    }
    this.order = null;
    this.settingsTab = null;
    // v2.10.6: last-resort document-level sweep — catches anything the
    // enumerated views missed (a restore that threw mid-loop, a detached
    // container, a popout window) so no injected node outlives the plugin.
    this.__globalSweepFallback();
    // v2.10.9: forensic evidence shows icons still on screen after unload
    // while both sweeps found ZERO nodes — something re-adds (or first-adds)
    // decorations after onunload completes. One delayed verification pass
    // (bare timer, one-shot, 250ms) removes anything that appeared late and
    // logs it; the trail in %TEMP%\beautify-diag.log identifies the timing.
    setTimeout(() => {
      try {
        // re-enumerate: delegatedViews is cleared by now; collapsed subtrees
        // may still hold cached rows
        for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
          const n = this.__sweepCachedRows(leaf.view);
          if (n) __bdiag("POST-UNLOAD cached-row sweep removed " + n + " node(s)"); // [diag]
        }
        this.__globalSweepFallback(true);
      } catch (e) {
        /* best-effort */
      }
    }, 250);
    // v2.10.11: a one-shot timer loses the race against the USER — expanding
    // a collapsed folder re-attaches cached rows whenever they look, which
    // the 250ms pass cannot see. Watch the explorer containers for 60s and
    // sweep on any mutation (debounced), then disconnect. Everything it
    // removes is plugin-injected by definition; the observer cannot outlive
    // its timer — and it steps aside the moment a NEW plugin instance loads
    // (era counter below), so a quick re-enable never fights its own icons.
    try {
      const era = (globalThis.__beautifyEra = (globalThis.__beautifyEra || 0) + 1);
      const containers = [];
      for (const leaf of this.app.workspace.getLeavesOfType("file-explorer"))
        if (leaf.view && leaf.view.containerEl) containers.push(leaf.view.containerEl);
      if (containers.length) {
        let total = 0,
          scheduled = false;
        const stop = () => observer.disconnect();
        const sweepNow = () => {
          scheduled = false;
          if (globalThis.__beautifyEra !== era) {
            stop();
            return;
          }
          for (const el of containers) {
            try {
              el.querySelectorAll(".bn-add-child,.bn-item-icon,.bn-quick,.bn-count").forEach(
                function (n) {
                  if (typeof n.remove === "function") {
                    n.remove();
                    total++;
                  }
                }
              );
            } catch (e) {
              /* container may be gone */
            }
          }
        };
        var observer = new MutationObserver(function () {
          if (globalThis.__beautifyEra !== era) {
            stop();
            return;
          }
          if (scheduled) return;
          scheduled = true;
          setTimeout(sweepNow, 100);
        });
        for (const el of containers) observer.observe(el, { childList: true, subtree: true });
        setTimeout(function () {
          stop();
          if (total) __bdiag("POST-UNLOAD watchdog removed " + total + " node(s) within 60s"); // [diag]
        }, 60000);
      }
    } catch (e) {
      /* best-effort */
    }
  }
  // v2.10.10: sweep the explorer's CACHED row elements. Collapsed folders are
  // detached from the DOM but Obsidian keeps their row elements (view.fileItems)
  // and re-attaches them VERBATIM on expand — icons included. DOM-level sweeps
  // see none of them (hence "removed 0" while icons visibly returned), so walk
  // every cached item's element as well.
  __sweepCachedRows(view) {
    let removed = 0;
    try {
      const items = view && view.fileItems;
      if (!items || typeof items.forEach !== "function") return 0;
      items.forEach(function (item) {
        // containerEl covers the row AND any still-attached child subtree
        const el = item && (item.containerEl || item.selfEl || item.titleEl);
        if (!el || typeof el.querySelectorAll !== "function") return;
        el.querySelectorAll(".bn-add-child,.bn-item-icon,.bn-count").forEach(function (n) {
          if (typeof n.remove === "function") {
            n.remove();
            removed++;
          }
        });
        if (item) item.__bnIconEl = null;
      });
    } catch (e) {
      /* best-effort */
    }
    return removed;
  }
  __globalSweepFallback(late) {
    const docs = new Set();
    try {
      if (typeof document !== "undefined") docs.add(document);
    } catch (e) {
      /* no main document in this context */
    }
    try {
      const active = this.app.workspace.activeDocument;
      if (active) docs.add(active);
    } catch (e) {
      /* best-effort */
    }
    try {
      for (const win of Object.values(this.app.windows || {}))
        if (win && win.document) docs.add(win.document);
    } catch (e) {
      /* best-effort */
    }
    let removed = 0;
    for (const doc of docs) {
      try {
        if (typeof doc.querySelectorAll !== "function") continue;
        doc.querySelectorAll(".bn-add-child,.bn-item-icon,.bn-count,.bn-quick,.bn-task-btn")
          .forEach(function (n) {
            if (typeof n.remove === "function") {
              n.remove();
              removed++;
            }
          });
      } catch (e) {
        /* best-effort */
      }
    }
    if (removed) __bdiag((late ? "POST-UNLOAD " : "") + "global sweep removed " + removed + " leftover node(s)"); // [diag]
    else if (late) __bdiag("post-unload verification: clean, 0 leftover node(s)"); // [diag]
  }
};

module.exports = { default: BeautifyPlugin };

/* nosourcemap */
