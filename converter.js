/* Inkwell — client-side TXT → EPUB converter
   Encoding auto-detection + EPUB 3 packaging. No network, no upload. */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const drop = $("drop"), fileInput = $("file"), queue = $("queue"),
        opts = $("opts"), goBtn = $("go"), clearBtn = $("clear"),
        statusEl = $("status"), titleEl = $("title"), authorEl = $("author");

  let files = []; // { file, name, bytes, encoding, confident, text, padding }

  /* ---------- Encoding detection ---------- */

  // Some "TXT之夢"-style files prepend a run of filler bytes (e.g. 0xF9, 0x00)
  // before the real Big5/UTF-8 content. Detect and strip that run so it
  // doesn't poison encoding detection.
  function stripPadding(bytes) {
    if (bytes.length > 8) {
      const b0 = bytes[0];
      if (b0 === 0xF9 || b0 === 0xFA || b0 === 0xFB || b0 === 0x00) {
        let i = 0;
        while (i < bytes.length && bytes[i] === b0) i++;
        if (i >= 4) return { body: bytes.subarray(i), padding: i };
      }
    }
    return { body: bytes, padding: 0 };
  }

  // Returns { encoding, confident }
  function detectEncoding(bytes) {
    // 1) BOM checks
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)
      return { encoding: "utf-8", confident: true };
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE)
      return { encoding: "utf-16le", confident: true };
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF)
      return { encoding: "utf-16be", confident: true };

    // 2) Strict UTF-8 validation — if it validates, it's almost certainly UTF-8
    if (isValidUtf8(bytes)) return { encoding: "utf-8", confident: true };

    // 3) Score legacy multi-byte encodings, pick the cleanest decode.
    //    big5 and cp950 (Windows Big5 superset) are both tried — many
    //    Traditional-Chinese novel TXTs use cp950 extension characters that
    //    plain big5 cannot decode.
    const candidates = ["big5", "gbk", "gb18030", "shift_jis", "euc-jp", "euc-kr", "windows-1252"];
    let best = { encoding: "windows-1252", score: -Infinity };
    for (const enc of candidates) {
      const s = scoreDecode(bytes, enc);
      if (s > best.score) best = { encoding: enc, score: s };
    }
    return { encoding: best.encoding, confident: false };
  }

  function isValidUtf8(bytes) {
    let i = 0;
    const n = bytes.length;
    while (i < n) {
      const b = bytes[i];
      if (b <= 0x7F) { i++; continue; }
      let extra;
      if ((b & 0xE0) === 0xC0) { extra = 1; if (b < 0xC2) return false; }
      else if ((b & 0xF0) === 0xE0) extra = 2;
      else if ((b & 0xF8) === 0xF0) { extra = 3; if (b > 0xF4) return false; }
      else return false;
      if (i + extra >= n) return false;
      for (let j = 1; j <= extra; j++) {
        if ((bytes[i + j] & 0xC0) !== 0x80) return false;
      }
      i += extra + 1;
    }
    return true;
  }

  // Heuristic: decode with fatal=false (so errors become U+FFFD), then
  // penalize replacement chars and PUA chars, reward expected ranges.
  function scoreDecode(bytes, enc) {
    let text;
    try {
      text = new TextDecoder(enc, { fatal: false }).decode(bytes);
    } catch (e) {
      return -Infinity; // encoding unsupported by this browser
    }
    let replacements = 0, cjk = 0, kana = 0, ascii = 0, pua = 0;
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (c === 0xFFFD) { replacements++; continue; }
      if (c >= 0xE000 && c <= 0xF8FF) { pua++; continue; }   // private-use: bad sign
      if (c >= 0x4E00 && c <= 0x9FFF) cjk++;                 // CJK ideographs
      else if (c >= 0x3040 && c <= 0x30FF) kana++;           // hiragana/katakana
      else if (c >= 0x20 && c <= 0x7E) ascii++;              // printable ASCII
      else if (c >= 0xAC00 && c <= 0xD7A3) cjk++;            // hangul
    }
    // PUA characters mean the decode produced meaningless glyphs — penalize hard.
    return cjk * 2 + kana * 2 + ascii * 0.3 - replacements * 8 - pua * 6;
  }

  // Browsers don't expose a separate "cp950" label, but their "big5" decoder
  // is actually the WHATWG Big5 (a cp950 superset), so "big5" already covers
  // the Windows extension characters. We keep the label friendly below.
  function decode(bytes, encoding) {
    try {
      return new TextDecoder(encoding, { fatal: false }).decode(bytes);
    } catch (e) {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
  }

  const ENC_LABEL = {
    "utf-8": "UTF-8", "utf-16le": "UTF-16LE", "utf-16be": "UTF-16BE",
    "big5": "Big5", "gbk": "GBK", "gb18030": "GB18030", "shift_jis": "Shift-JIS",
    "euc-jp": "EUC-JP", "euc-kr": "EUC-KR", "windows-1252": "Windows-1252"
  };

  /* ---------- Chapter parsing ---------- */

  // Matches: 第1章 / 第一章 / 第 12 回 / 卷一 / Chapter 3 / CHAPTER IV / 楔子 / 番外  (line start)
  // No \b — word boundaries don't apply to CJK characters.
  const CHAP_RE = /^\s*(第\s*[0-9零一二三四五六七八九十百千兩两]+\s*[章回節节卷]|卷\s*[0-9零一二三四五六七八九十]+\s*[章回部]?|chapter\s+[0-9ivxlcdm]+|chapter\s+\w+|楔子|序章|序言|前言|後記|后记|尾聲|尾声|番外)/i;

  function splitChapters(text, mode) {
    text = text.replace(/\r\n?/g, "\n");
    if (mode === "none") {
      return [{ title: "正文", lines: text.split("\n") }];
    }
    if (mode === "blank") {
      const blocks = text.split(/\n\s*\n\s*\n+/);
      return blocks.map((b, i) => ({
        title: "Part " + (i + 1),
        lines: b.split("\n")
      })).filter(c => c.lines.join("").trim());
    }
    // auto
    const lines = text.split("\n");
    const chapters = [];
    let current = null;
    for (const line of lines) {
      if (CHAP_RE.test(line) && line.trim().length <= 40) {
        current = { title: line.trim(), lines: [] };
        chapters.push(current);
      } else {
        if (!current) { current = { title: "前言", lines: [] }; chapters.push(current); }
        current.lines.push(line);
      }
    }
    if (chapters.length <= 1) return [{ title: "正文", lines: text.split("\n") }];
    return chapters;
  }

  /* ---------- EPUB building ---------- */

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function chapterXhtml(title, lines, lang) {
    // Decide the paragraph style of this chapter:
    // Many Chinese novel TXTs put each paragraph on its own line (indented with
    // full-width spaces) with NO blank line between them. Others wrap a single
    // paragraph across several lines and separate paragraphs with a blank line.
    const nonBlank = lines.filter(l => l.trim() !== "");
    const blanks = lines.length - nonBlank.length;
    // Primary signal: if most non-blank lines start with an indent (full-width
    // space 　 or 2+ regular spaces), this is the "one paragraph per line"
    // convention used by the vast majority of Chinese novel TXTs.
    const indented = nonBlank.filter(l => /^(\u3000|\s{2,})/.test(l)).length;
    const mostlyIndented = nonBlank.length > 0 && indented >= nonBlank.length * 0.6;
    // Without indentation, only treat each line as a paragraph when there are
    // essentially no blank-line separators at all (so we don't merge real
    // blank-separated paragraphs by mistake).
    const linePerPara = mostlyIndented || (blanks === 0 && nonBlank.length > 1);

    const paras = [];
    if (linePerPara) {
      for (const ln of lines) {
        const t = ln.trim();
        if (t !== "") paras.push("<p>" + esc(t) + "</p>");
      }
    } else {
      // Blank-line separated: join consecutive non-blank lines into one paragraph.
      let buf = [];
      const flush = () => {
        if (buf.length) { paras.push("<p>" + esc(buf.join("")) + "</p>"); buf = []; }
      };
      for (const ln of lines) {
        if (ln.trim() === "") flush();
        else buf.push(ln.trim());
      }
      flush();
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}" lang="${lang}">
<head><meta charset="utf-8"/><title>${esc(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><h2 class="chap">${esc(title)}</h2>
${paras.join("\n")}
</body></html>`;
  }

  // Reader-safe layout: fixed em margins (percentage margins + tall line-height
  // can push the last line past a paginated reader's page boundary and clip it),
  // moderate line-height, and orphan/widow + break rules so paragraphs and
  // headings are never split awkwardly across pages.
  const CSS = `html,body{margin:0;padding:0;}
body{font-family:serif;margin:1em 1.2em;}
h2.chap{font-size:1.4em;font-weight:bold;text-align:center;
  line-height:1.3;padding-top:0.5em;padding-bottom:1em;
  page-break-before:always;break-before:page;
  page-break-after:avoid;break-after:avoid;}
p{margin:0;padding-top:0.35em;padding-bottom:0.35em;
  line-height:1.5;text-indent:2em;text-align:justify;
  orphans:2;widows:2;}`;

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  async function buildEpub(title, author, lang, chapters) {
    const zip = new JSZip();
    const id = "urn:uuid:" + uuid();
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

    zip.folder("META-INF").file("container.xml",
`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

    const oebps = zip.folder("OEBPS");
    oebps.file("style.css", CSS);

    const items = [], spine = [], navItems = [];
    chapters.forEach((ch, i) => {
      const fn = `chap${String(i + 1).padStart(3, "0")}.xhtml`;
      oebps.file(fn, chapterXhtml(ch.title, ch.lines, lang));
      items.push(`<item id="c${i}" href="${fn}" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="c${i}"/>`);
      navItems.push(`<li><a href="${fn}">${esc(ch.title)}</a></li>`);
    });

    oebps.file("nav.xhtml",
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>目錄</h1><ol>
${navItems.join("\n")}
</ol></nav></body></html>`);

    oebps.file("content.opf",
`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${id}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
<dc:creator>${esc(author)}</dc:creator>
<dc:language>${lang}</dc:language>
<meta property="dcterms:modified">${now}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
${items.join("\n")}
</manifest>
<spine>
${spine.join("\n")}
</spine>
</package>`);

    return zip.generateAsync({
      type: "blob",
      mimeType: "application/epub+zip",
      compression: "DEFLATE"
    });
  }

  /* ---------- UI wiring ---------- */

  function renderQueue() {
    if (!files.length) {
      queue.classList.remove("show");
      opts.classList.remove("show");
      goBtn.disabled = true;
      return;
    }
    queue.classList.add("show");
    opts.classList.add("show");
    goBtn.disabled = false;
    queue.innerHTML = files.map(f => `
      <div class="row">
        <span class="name" title="${esc(f.name)}">${esc(f.name)}</span>
        <span class="enc ${f.confident ? "" : "guess"}">${ENC_LABEL[f.encoding] || f.encoding}${f.confident ? "" : " ?"}${f.padding ? " ·trimmed" : ""}</span>
        <span class="meta">${(f.bytes.length / 1024).toFixed(1)} KB</span>
      </div>`).join("");

    if (files.length === 1 && !titleEl.value) {
      titleEl.value = files[0].name.replace(/\.[^.]+$/, "");
    }
  }

  async function addFiles(list) {
    for (const file of list) {
      const all = new Uint8Array(await file.arrayBuffer());
      const { body, padding } = stripPadding(all);
      const det = detectEncoding(body);
      const text = decode(body, det.encoding);
      files.push({ file, name: file.name, bytes: all, padding, ...det, text });
    }
    renderQueue();
    const anyGuess = files.some(f => !f.confident);
    setStatus(anyGuess
      ? "Encoding is a best guess — check the output if characters look off."
      : "");
  }

  function setStatus(msg, isErr) {
    statusEl.textContent = msg;
    statusEl.classList.toggle("err", !!isErr);
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener("change", e => addFiles(e.target.files));

  ["dragenter", "dragover"].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hot"); }));
  ["dragleave", "drop"].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("hot"); }));
  drop.addEventListener("drop", e => {
    const f = [...e.dataTransfer.files].filter(x => /\.txt$/i.test(x.name) || x.type === "text/plain");
    if (f.length) addFiles(f);
    else setStatus("Only plain-text (.txt) files are supported.", true);
  });

  clearBtn.addEventListener("click", () => {
    files = []; fileInput.value = ""; titleEl.value = ""; authorEl.value = "";
    renderQueue(); setStatus("");
  });

  goBtn.addEventListener("click", async () => {
    if (!files.length) return;
    goBtn.disabled = true;
    const mode = $("chapmode").value, lang = $("lang").value;
    const author = authorEl.value.trim() || "Unknown";
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setStatus(`Building EPUB ${i + 1} / ${files.length}…`);
        const title = (files.length === 1 ? titleEl.value.trim() : "") ||
                      f.name.replace(/\.[^.]+$/, "") || "Untitled";
        const chapters = splitChapters(f.text, mode);
        const blob = await buildEpub(title, author, lang, chapters);
        download(blob, title.replace(/[\\/:*?"<>|]/g, "_") + ".epub");
      }
      setStatus(`Done — ${files.length} EPUB${files.length > 1 ? "s" : ""} ready.`);
    } catch (err) {
      console.error(err);
      setStatus("Something broke while building. Check the console.", true);
    } finally {
      goBtn.disabled = false;
    }
  });
})();
