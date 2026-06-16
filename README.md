# Inkwell — Online TXT → EPUB Converter

A fully **client-side** ebook converter. Drop in a plain-text file and get a clean, reader-ready **EPUB 3** back. Files never leave the browser — perfect for hosting free on **GitHub Pages**.

## Features

- **Automatic encoding detection** — BOM sniffing, strict UTF-8 validation, then statistical scoring across **Big5, GBK, Shift-JIS, EUC-JP, EUC-KR, UTF-8/16, Windows-1252**. No more mojibake on Chinese/Japanese text files.
- **Chapter splitting** — auto-detects headings (`第一章`, `第 12 回`, `卷一`, `楔子`, `Chapter 4`, …) into a real table of contents, or split on blank-line gaps, or keep as one chapter.
- **Spec-valid EPUB 3** — `mimetype` stored first per spec; opens in Apple Books, Calibre, KOReader, etc.
- **Batch conversion** — drop multiple `.txt` files at once.
- **Zero backend** — pure HTML/CSS/JS + [JSZip] (loaded from CDN). Nothing is uploaded.

## Run locally

Just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy to GitHub Pages

1. Create a repo and push these files (`index.html`, `converter.js`, `README.md`, `LICENSE`).
2. In the repo: **Settings → Pages → Source** → select your branch (`main`) and `/ (root)`.
3. Your converter goes live at `https://<username>.github.io/<repo>/`.

No build step, no dependencies to install.

## How encoding detection works

1. **BOM check** — UTF-8/UTF-16 byte-order marks are unambiguous, so they win immediately.
2. **UTF-8 validation** — if every byte sequence is valid UTF-8, it's treated as UTF-8 (very low false-positive rate).
3. **Scored decode** — otherwise each candidate legacy encoding is decoded with the browser's native `TextDecoder`; the one producing the most valid CJK/kana characters and fewest replacement characters (U+FFFD) wins. A guessed encoding is flagged in the UI with a `?` so you can sanity-check the output.

## License

MIT — see [LICENSE](LICENSE).

[JSZip]: https://stuk.github.io/jszip/
