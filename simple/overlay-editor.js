// The other half of simple/overlay.js: where a broadcaster actually writes one.
//
// ── WHY A BLOCK EDITOR AND NOT A TEXT BOX ───────────────────────────────────────────────────
//
// The renderer takes a list of typed blocks, never markup, because this origin serves
// `require-trusted-types-for 'script'; trusted-types 'none'` and there is no route from a string
// to DOM in it at all. That decision is explained in overlay.js and is not revisited here.
//
// It does, though, decide what this file can be. Two alternatives were available:
//
//   A raw JSON textarea. Cheapest to write, and it makes malformed input the broadcaster's
//   problem — a missing brace is an overlay that silently renders nothing.
//
//   A markup of our own ("# heading", "- bullet"). Friendlier to type, and a parser with its own
//   bugs, its own escaping questions, and a format nobody else implements.
//
// A row per block, with a type and its fields, is the third option: it CANNOT produce malformed
// JSON, it needs no parser, and it puts the block format on screen where somebody can see what
// their overlay actually is. In a repo whose pitch is "the code is small enough to read", the
// editor agreeing with the format one-to-one is worth more than the keystrokes a markup saves.
//
// ── THE PREVIEW IS THE REAL RENDERER ────────────────────────────────────────────────────────
//
// mountOverlay() below is the very function the viewer's page calls, on the very blocks that
// will be stored. So a refusal — a same-origin embed, an http:// image, a block type that does
// not exist — is reported to the author while they are typing, in the same words, rather than
// being discovered by a viewer looking at a gap. An editor with its own idea of what renders
// would eventually disagree with the renderer, and the author would be the last to know.

import { mountOverlay } from "./overlay.js";

/**
 * The block types, and the fields each one carries. This table IS the format — overlay.js
 * validates against the same shapes, and anything not listed here cannot be authored.
 *
 * kind: "line" a single-line input · "area" a textarea · "lines" a textarea, one item per line
 *       "url"  a single-line input typed as a URL · "num" a small number input
 */
const TYPES = {
  h:     { label: "Heading",       fields: [["text", "line", "A heading"]] },
  p:     { label: "Paragraph",     fields: [["text", "area", "Something for your viewers to read"]] },
  ul:    { label: "Bulleted list", fields: [["items", "lines", "One item per line"]] },
  ol:    { label: "Numbered list", fields: [["items", "lines", "One item per line"]] },
  a:     { label: "Link",          fields: [["text", "line", "What it says"], ["href", "url", "https://…"]] },
  img:   { label: "Image",         fields: [["src", "url", "https://…"], ["alt", "line", "What it shows"]] },
  hr:    { label: "Divider",       fields: [] },
  embed: { label: "Embed",         fields: [["src", "url", "https://… — not earthseed.live"], ["height", "num", "420"]] },
};

const MAX_ROWS = 40; // the renderer's own limit; there is no point authoring past it

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/**
 * Mount the editor into `host`.
 *
 * @param {Element} host
 * @param {{
 *   initial: string|unknown[],
 *   onSave: (json: string) => Promise<boolean>,
 * }} opts
 */
export function initOverlayEditor(host, opts) {
  /** @type {{type: string, values: Record<string, string>}[]} */
  let rows = [];

  // Read whatever is stored back into rows. Anything unrecognised is dropped rather than
  // preserved-and-hidden: an overlay carrying a block this editor cannot show would be silently
  // deleted the next time Save was pressed, which is the worse of the two losses.
  {
    let blocks = opts.initial;
    if (typeof blocks === "string") {
      try {
        blocks = blocks.trim() ? JSON.parse(blocks) : [];
      } catch {
        blocks = [];
      }
    }
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        const t = b && typeof b === "object" ? String(/** @type {any} */ (b).t ?? "") : "";
        if (!TYPES[t]) continue;
        /** @type {Record<string,string>} */
        const values = {};
        for (const [name] of TYPES[t].fields) {
          const v = /** @type {any} */ (b)[name];
          values[name] = Array.isArray(v) ? v.join("\n") : v == null ? "" : String(v);
        }
        rows.push({ type: t, values });
      }
    }
  }

  const list = h("div", "ov-rows");
  const previewHost = h("div", "ov-preview");
  const notes = h("div", "hint ov-notes");
  const status = h("div", "hint ov-status");
  const addBtn = /** @type {HTMLButtonElement} */ (h("button", "ov-add", "Add a block"));
  const saveBtn = /** @type {HTMLButtonElement} */ (h("button", "ov-save", "Save overlay"));
  addBtn.type = "button";
  saveBtn.type = "button";

  /** Rows → the blocks that will be stored. Empty fields are dropped, not stored as "". */
  const toBlocks = () =>
    rows
      .map((r) => {
        /** @type {Record<string, unknown>} */
        const b = { t: r.type };
        for (const [name, kind] of TYPES[r.type].fields) {
          const raw = (r.values[name] ?? "").trim();
          if (!raw) continue;
          if (kind === "lines") b[name] = raw.split("\n").map((s) => s.trim()).filter(Boolean);
          else if (kind === "num") b[name] = Number(raw);
          else b[name] = raw;
        }
        return b;
      })
      // A block with nothing in it is not an empty paragraph the viewer should see; it is a row
      // somebody added and has not filled in yet.
      .filter((b) => b.t === "hr" || Object.keys(b).length > 1);

  const refreshPreview = () => {
    const blocks = toBlocks();
    const removed = mountOverlay(previewHost, blocks);
    // The renderer's own words for what it would not render. Shown here so the author finds out
    // now, rather than from a viewer describing a gap.
    notes.textContent = removed.length ? `Not shown to viewers: ${removed.join("; ")}` : "";
    notes.hidden = removed.length === 0;
    previewWrap.hidden = blocks.length === 0;
  };

  /** @param {number} i */
  const renderRow = (i) => {
    const row = rows[i];
    const el = h("div", "ov-row");

    const sel = /** @type {HTMLSelectElement} */ (h("select", "ov-type"));
    sel.setAttribute("aria-label", "Block type");
    for (const [t, def] of Object.entries(TYPES)) {
      const o = /** @type {HTMLOptionElement} */ (h("option", undefined, def.label));
      o.value = t;
      if (t === row.type) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      // Carry text across where the new type has a field of the same name. Changing Paragraph to
      // Heading should not throw away the sentence.
      const keep = row.values;
      row.type = sel.value;
      row.values = {};
      for (const [name] of TYPES[row.type].fields) row.values[name] = keep[name] ?? "";
      redraw();
    });
    el.appendChild(sel);

    const fields = h("div", "ov-fields");
    for (const [name, kind, placeholder] of TYPES[row.type].fields) {
      const isArea = kind === "area" || kind === "lines";
      const f = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (h(isArea ? "textarea" : "input"));
      if (!isArea) {
        /** @type {HTMLInputElement} */ (f).type = kind === "num" ? "number" : kind === "url" ? "url" : "text";
      } else {
        /** @type {HTMLTextAreaElement} */ (f).rows = kind === "lines" ? 3 : 2;
      }
      f.className = "ov-field";
      f.placeholder = placeholder;
      f.value = row.values[name] ?? "";
      f.setAttribute("aria-label", `${TYPES[row.type].label}: ${name}`);
      f.addEventListener("input", () => {
        row.values[name] = f.value;
        refreshPreview();
        dirty(true);
      });
      fields.appendChild(f);
    }
    el.appendChild(fields);

    const tools = h("div", "ov-tools");
    /** @param {string} label @param {string} title @param {() => void} fn @param {boolean} [off] */
    const tool = (label, title, fn, off) => {
      const b = /** @type {HTMLButtonElement} */ (h("button", "ov-tool", label));
      b.type = "button";
      b.title = title;
      b.setAttribute("aria-label", title);
      b.disabled = !!off;
      b.addEventListener("click", () => {
        fn();
        redraw();
        dirty(true);
      });
      return b;
    };
    tools.appendChild(tool("↑", "Move up", () => {
      [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
    }, i === 0));
    tools.appendChild(tool("↓", "Move down", () => {
      [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]];
    }, i === rows.length - 1));
    tools.appendChild(tool("×", "Remove this block", () => {
      rows.splice(i, 1);
    }));
    el.appendChild(tools);
    return el;
  };

  let unsaved = false;
  /** @param {boolean} v */
  const dirty = (v) => {
    unsaved = v;
    saveBtn.textContent = v ? "Save overlay •" : "Save overlay";
    if (v) {
      status.textContent = "";
      status.hidden = true;
    }
  };

  const redraw = () => {
    list.replaceChildren(...rows.map((_, i) => renderRow(i)));
    addBtn.disabled = rows.length >= MAX_ROWS;
    refreshPreview();
  };

  addBtn.addEventListener("click", () => {
    if (rows.length >= MAX_ROWS) return;
    rows.push({ type: "p", values: { text: "" } });
    redraw();
    dirty(true);
    // Put the cursor where the person is about to type. Adding a row and then having to find it
    // is the kind of small rudeness that makes an editor feel like a form.
    /** @type {HTMLElement|null} */ (list.lastElementChild?.querySelector(".ov-field") ?? null)?.focus();
  });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    status.hidden = false;
    status.textContent = "saving…";
    try {
      const ok = await opts.onSave(JSON.stringify(toBlocks()));
      // Say which it was. A save that reports nothing is indistinguishable from one that failed,
      // and this one can genuinely fail — it is signed, and the signature expires.
      status.textContent = ok
        ? "Saved. Viewers see this the next time they open the link."
        : "Could not save — the change is still here, so try again.";
      if (ok) dirty(false);
    } finally {
      saveBtn.disabled = false;
    }
  });

  const bar = h("div", "ov-bar");
  bar.append(addBtn, saveBtn);
  // The preview and its label live or die together: a heading over an empty box says a broadcast
  // will show viewers nothing, in a place where nothing is exactly what it should say instead.
  const previewWrap = h("div", "ov-preview-wrap");
  previewWrap.append(h("div", "hint", "What viewers will see:"), previewHost);
  host.replaceChildren(list, bar, status, notes, previewWrap);
  redraw();
  dirty(false);

  return {
    /** Everything currently authored, as the JSON string that would be stored. */
    json: () => JSON.stringify(toBlocks()),
    hasUnsavedChanges: () => unsaved,
  };
}
