# 98.css (vendored copy)

Windows 98 look for the Yesteryear popup. Copied unmodified from the npm package.

- Package: `98.css@0.1.21`, published to npm on 2025-04-28 (pinned; fetched 2026-11-10 with
  `npm pack 98.css@0.1.21 --ignore-scripts`).
- Tarball: sha1 `61e3988a58bbd44fdab3bae58c698729d52d7a5c`,
  integrity `sha512-ddk5qtUWyapM0Bzd5jwGExoE5fdSEGrP+F5VbYjyZLf2c9UVmn6w2NPTvCsoD4BWdGsjdLjlkQGhWwWTJcYQJQ==`
- Upstream: https://github.com/jdan/98.css

## Files

| File | From the package | SHA-256 |
|---|---|---|
| `98.css` | `dist/98.css` | `2201559a3d41c645ca7ca3142d9488e68e6f3d79fb912f5acac6021ac75e66c0` |
| `98.css.map` | `dist/98.css.map` | `de6d116c899c6fac1de36eb903afb3c67c9796317e39996408e4560137f8c5c2` |
| `ms_sans_serif.woff` | `dist/ms_sans_serif.woff` | `11318ea166b8c0112088af3fa038da18071a3fe93d0a39c894998a940e804ba0` |
| `ms_sans_serif.woff2` | `dist/ms_sans_serif.woff2` | `11b5a68acb6b967d1faa5a3f58432028e9c9cada37c8778d9dcc7415dca73a32` |
| `ms_sans_serif_bold.woff` | `dist/ms_sans_serif_bold.woff` | `e7b28b601df431c5f7b62c466380ac9869395eacf4c9fafec5f4d7a67040e963` |
| `ms_sans_serif_bold.woff2` | `dist/ms_sans_serif_bold.woff2` | `5f3fbc5790b315fc158b749078e7fd1d74e1f9b463f6b7266c1908cb82a450ae` |
| `LICENSE` | `LICENSE` | `8933005629892c51d896f7591b5e79c39a17617ce678231e4c3aa7d412d2682f` |
| `font-licenses/*/license.txt`, `readme.txt` | `fonts/src/*/` | |

`98.css` loads the fonts by relative `url()`, so they must stay in this folder next to it.

## Licences

- **98.css** (the CSS): MIT, Copyright 2020 Jordan Scales. Full text in `LICENSE`.
- **Font "Pixelated MS Sans Serif"** (the four `ms_sans_serif*.woff/.woff2` files): **not MIT**.
  It is the FontStructions "MS Sans Serif" (https://fontstruct.com/fontstructions/show/1384746)
  and "MS Sans Serif Bold" (https://fontstruct.com/fontstructions/show/1384862) by "lou",
  licensed **Creative Commons Attribution-ShareAlike 3.0** (https://creativecommons.org/licenses/by-sa/3.0/),
  converted to woff/woff2 by 98.css. It is a fan-made pixel recreation, not Microsoft's font.
  - Attribution: keep this notice and the files in `font-licenses/` with the fonts.
  - Share-alike: a modified version of the font may only be shared under CC BY-SA 3.0 too.
    We use the files unmodified.
  - The FontStruct readme asks that redistributions carry its `license.txt` and `readme.txt`;
    both are in `font-licenses/ms-sans-serif/` and `font-licenses/ms-sans-serif-bold/`.

## Updating

1. In a new, empty temp folder: `npm pack 98.css@<version> --ignore-scripts`, using a release at
   least two weeks old, then extract it into another empty folder.
2. Copy `dist/98.css`, `dist/98.css.map`, `dist/ms_sans_serif*.woff*`, `LICENSE`, and the
   `license.txt` + `readme.txt` of both folders in `fonts/src/` to the places listed above.
3. Update the version, date and hashes here, then run `node --test "tests/ui/*.test.mjs"`
   (it checks that every `url()` in `98.css` resolves to a file in this folder).
