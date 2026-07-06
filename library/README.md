# FableCut asset library

Default, reusable assets. Everything here shows up live in the editor's left
panel tabs and can be dropped onto the timeline — files are referenced in
place (`/library/...`), never copied into the project.

| Folder      | Editor tab | Contents                                                        |
| ----------- | ---------- | --------------------------------------------------------------- |
| `sfx/`      | Sound FX   | whooshes, clicks, risers, impacts… (`.mp3 .wav .ogg .m4a`)       |
| `elements/` | Elements   | overlay art: PNGs with alpha, light leaks, textures, short loops |
| `svg/`      | SVG        | vector animations authored by Claude (see CLAUDE.md conventions) |
| `fonts/`    | (Font editor) | `.ttf .otf .woff .woff2` — auto-registered, family = file name |

Drop free assets you find online into the matching folder — the open editor
refreshes the list automatically. Subfolders are allowed and listed too.
