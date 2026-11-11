# Office Assistant characters (vendored data)

Clippy and Rover for the first-run tour (`src/tour/`). The tour plays them with its own small player
(`src/tour/agent.js`); no clippy.js code is shipped, only the character data.

## Where it comes from

- Package: `clippyjs@0.1.0` on npm, published 2026-02-17 (pinned; fetched 2026-11-11 with
  `npm pack clippyjs@0.1.0 --ignore-scripts`). Upstream: https://github.com/pi0/clippyjs (now
  `pithings/clippy`), "a fresh rewrite of Clippy.JS" by Smore (smore.com/clippy-js).
- Tarball: sha1 `7cb9d096d0414df5fcbf576b2b696f38a1a16a96`, integrity
  `sha512-XnchzSR8H8X43TvwnAktK5xDewKGSyfGu8DagBZCbOUdx0dWAFrFdxdCWlaJkyfx4M3Amvvu13jbHQ/IYQOD+w==`
  (checked against the npm registry).
- The package ships each agent as three ES modules (`dist/agents/<id>/agent.mjs`, `map.mjs`,
  `sounds-mp3.mjs`), each one big literal. `tests/tour/vendor_clippy.mjs` turned them into plain files
  WITHOUT running the downloaded code: a literal-only parser reads the text and the tool stops if a
  file has any other shape. Then:
  - `agent.json`: the animation data, unchanged (frame size, frames with duration, sprite offsets,
    sounds, branches, exit branches);
  - `map.png`: the sprite sheet, decoded from its base64 data URL;
  - `sounds/<n>.mp3`: the sounds, decoded from their base64 data URLs.
- The sprites and sounds were originally unpacked from Microsoft Agent character files with
  Double Agent (Cinnamon Software), as the clippy.js projects credit.

## Licence situation (read before sharing the extension)

- **clippy.js code: MIT** (Copyright (c) 2012 Fireplace, Inc - 2017 Pooya Parsa). Full text in
  `LICENSE`, copied unchanged from the package (`LICENCE` there).
- **The characters are not MIT.** The same licence file says: "THE ABOVE LICENSE IS FOR THE CODE
  (JAVASCRIPT AND CSS) IN CLIPPY.JS ONLY. All Microsoft agents, including agent names, the Clippy
  brand and all resources are the property of Microsoft and their respective owners." So the
  sprites, sounds and names "Clippy" and "Rover" belong to Microsoft.
- Fine for Yesteryear as it is: a personal use copy, loaded unpacked in your own Chrome. Do NOT
  publish the extension with these files (Chrome Web Store, a public download) without replacing
  the characters or getting permission. The tour itself does not depend on them: any clippy.js-format
  character (agent.json + map.png + sounds) works in `agents/<id>/`.

## Files

| File | Bytes | SHA-256 |
|---|---|---|
| `LICENSE` | 1291 | `9011e2cbb2481a2a591ed38997719b471a0a48ace3b8f809b3d6c0fd0aac2ac2` |
| `agents/clippy/agent.json` | 60654 | `8fa1bea12d9177f8f0c29216d2b4d321391200b2d53b203c6ee5b850e84d2c55` |
| `agents/clippy/map.png` | 1333530 | `880b63ac4d3fa84c78eceb02674c9eaedae032b2d85887539a7f6d107e5801e9` |
| `agents/clippy/sounds/1.mp3` | 1862 | `67d46f702c9a0ed120009349c08613f5c232201d3d51b5dd1150cafdbb6f03a1` |
| `agents/clippy/sounds/2.mp3` | 1339 | `913efc293affc6b01465da8cf26ffc14b9f8e5f541f81ea88677e43d3f316db7` |
| `agents/clippy/sounds/3.mp3` | 1339 | `3b080a6243c66009385a638d8a389abd87cfef3c332361d198e9fcd188c460e5` |
| `agents/clippy/sounds/4.mp3` | 1757 | `940c21aa75273f842ef5edc82c503ace2c941a3ab34933085805f93160df3ce8` |
| `agents/clippy/sounds/5.mp3` | 1130 | `092cd024cb1f16b658e5a85169ebc53ce6e17c5fcf491d400f9285b175f95032` |
| `agents/clippy/sounds/6.mp3` | 2567 | `5143983f2cc61ef114ff5522ab6c74685fc90c7b9c6c4e67c91ce6d138478bde` |
| `agents/clippy/sounds/7.mp3` | 1653 | `880b1bc0a8119f061bfcb75836219602f5fc3739ca1948f5b05aafc75347d585` |
| `agents/clippy/sounds/8.mp3` | 712 | `ab5645c44c89673bc61dc685b6df3963a4a50ea81c5e7502b784443f59855f14` |
| `agents/clippy/sounds/9.mp3` | 1444 | `77bb5e8e7b213e561843cc813063962808e4ecacd4378ca771c1cbd1a32c38c0` |
| `agents/clippy/sounds/10.mp3` | 608 | `1dff6917aff56843cae8f506c87cd4f43379e02f4f383df37f7695523dbf22cf` |
| `agents/clippy/sounds/11.mp3` | 1444 | `c502563c4fe604e2c6a78fb168e68764346cfaf97341a6d68e0c7a631fc8f2f6` |
| `agents/clippy/sounds/12.mp3` | 712 | `6056cc07040161cbba9d4822ebd787ac5729c510cf935d7a2a91b75c3f87d39b` |
| `agents/clippy/sounds/13.mp3` | 712 | `d50704dc056faf75553a32d21009f9aecd63e7443d8f64a88ce6e6dce5310903` |
| `agents/clippy/sounds/14.mp3` | 1130 | `8a506047a8e6fcbd20c5ee502a22e74a310990ed0fd814cc97f707d6474cf5b1` |
| `agents/clippy/sounds/15.mp3` | 503 | `50806fe03b8750e9c757eccba0a5b84269400f18a5f15b4052c0cb45d7025642` |
| `agents/rover/agent.json` | 52040 | `42350e68862590f346e966d088a66f0eb728ade3048eec8cf2ea3ed865bc4084` |
| `agents/rover/map.png` | 698394 | `dfa1d61a77f7237dc4cd439fc8b0d14e92608fe89d24cb332ad89f3194433cfa` |
| `agents/rover/sounds/1.mp3` | 1234 | `9bf390a0748ff1315a0aff1083f3b67ad5b8132083d81ac6aae05062e99c13ee` |
| `agents/rover/sounds/2.mp3` | 2279 | `b18d33cf9bbf2273c820b6dfe6e0db60ab4172c1d57de71ebc000c71edaae5f9` |
| `agents/rover/sounds/3.mp3` | 2697 | `41daeb045bcd1e7db9dd6b51b31b566bf6fe721d6c2b951253c6b8b1bcaae082` |
| `agents/rover/sounds/4.mp3` | 6877 | `8d5382dd690a47015aa9411832c3915d547bbe2cd2640b965e141e94480ab45c` |
| `agents/rover/sounds/5.mp3` | 2279 | `df5d17ed7e7509f047bc4835e687c8828963eaad826412c0d700446706803fe9` |
| `agents/rover/sounds/6.mp3` | 2697 | `e369948b6c071f613ab74bdadc3bd40934d0692dfe2fb6de53274dcdcc0dc4ce` |
| `agents/rover/sounds/7.mp3` | 1652 | `40fc7357b4941808e82f625de65e6ae520b4b793f4f05fe6fb64d131b24eed3d` |
| `agents/rover/sounds/8.mp3` | 477 | `a518fd6471fbe9a062f7c7c09c26a7e4a0b5079e68f1c102772adba881232df6` |
| `agents/rover/sounds/9.mp3` | 608 | `25372c56b622244ea239ad939125bbb60a9ebfc0b2ccdfef6239efddc110702d` |
| `agents/rover/sounds/10.mp3` | 608 | `661c85bcb732335fd2149a52d202af350ff021b58e7836e9e11f9dd5751fd7de` |

Sizes: Clippy frames 124 x 93 px (43 animations, sheet 3348 x 3162), Rover frames 80 x 80 px
(29 animations, sheet 2160 x 2160). Neither has a walking animation (`Move*`); the tour glides them.

## Updating or adding a character

1. In a new, empty temp folder: `npm pack clippyjs@<version> --ignore-scripts` (a release at least two
   weeks old), then `tar -xzf clippyjs-<version>.tgz` into another empty folder.
2. Adjust the version check and `AGENT_IDS` in `tests/tour/vendor_clippy.mjs` if needed, then
   `node tests/tour/vendor_clippy.mjs <that folder>`. It rewrites `agents/` and prints this table.
3. Update the table and dates here, then run `node --test tests/tour` (it checks every hash above,
   that every sprite offset lies inside `map.png`, and that every animation the tour uses exists).
