# Video Editing Agent

A local lab that tried to turn raw clips into an MP4 by asking models to analyze the footage, write an edit plan, and hand that plan to FFmpeg.

Status: lab dump, not a product. In the author's runs the pipeline produced MP4s, and those files were bad edits. The main hole is not a flipped-frame render bug. The director has no bar for rejecting uninteresting spans, so it glues a full timeline, the same shape as scoring every email at least near 40% suspicious. An automaton like this will not replace a paid editor; trends would need a continuous outside feed this repo does not provide. See `docs/STATUS.md`. Do not treat a finished MP4 as evidence that the edit is usable.

## What it tried

The intended pipeline had three stages:

1. **Analyze.** Transcribe speech, pull audio features, describe frames, and write indexes for the batch.
2. **Director.** Ask a model to turn those indexes into an edit recipe: which spans to keep, in what order.
3. **FFmpeg stitch.** Render that recipe to MP4.

The tree still contains that machinery: Node CLI, Python analysis scripts, prompt files, validators, and a render path under `src/render/`. Longer notes live in `docs/PIPELINE.md`, `docs/CONTEXT.md`, and `docs/RECIPE-VERSIONS.md`. Those notes describe the code as built. They are not a claim that the output is a good cut.

## What failed in the author's runs

- **Context dropped.** Batch context passed on the command line did not stay attached to later decisions. The director planned as if that brief was thinner than what was typed.
- **Inverted frames.** Some stitched shots came out upside down or otherwise flipped. That is a render symptom, not the root cause named in `docs/STATUS.md`.
- **Odd cuts.** Boundaries landed in the middle of speech or motion, and neighboring shots did not belong next to each other.
- **No bar for "interesting".** The director glued clips into a timeline because they existed and fit a schema. It had no working test for whether a span was worth keeping. Asking a model "is this cut interesting?" behaved like asking "is this email suspicious?": a soft yes on almost everything, so the recipe filled up.

There are no published accuracy numbers for this repo. The runs were the author's own footage, judged by watching the MP4. See `docs/STATUS.md`.

## How to run

This is a lab dump with a CLI. The commands below are the ones the tree already documents. They spend API credits and write under `output/`. They do not produce a reliable edit.

Requirements that the tree already states:

- Node.js 20+
- ffmpeg / ffprobe (optional paths in `.env`)
- `OPENAI_API_KEY` in `.env` (copy from `.env.example`; do not commit `.env`)
- Python 3.9+ and `pip3 install -r python/requirements.txt`

```bash
cp .env.example .env   # set OPENAI_API_KEY locally
npm install
pip3 install -r python/requirements.txt
```

```bash
# Full pipeline (analyze + director + review + thumbnails + publish)
npm run full -- --input ./inbox/moj-folder --context "vlog dzień 66/100"
# alias: npm run pipeline (same as full)

# Analyze only. Default stops at clip_profile. Does not run abstract/direct.
npm run analyze -- --input ./inbox/moj-folder

# Director on an existing batch
npm run direct -- --batch-id abc12345 --context "vlog dzień 66/100"

# Stitch an existing recipe to MP4
npm run render -- --batch-id abc12345

# Pipeline plus render
node src/cli.js run --input ./inbox/day --context "vlog" --render --render-profile preview

# Resume from a named step
node src/cli.js run --batch-id abc12345 --from-step topic_index --force

# Re-apply local enrich without a new GPT call
node src/cli.js enrich --batch-id abc12345 --source draft --target final --force

node src/cli.js report --batch-id abc12345
node src/cli.js doctor --batch-id abc12345
```

Work files land in `output/.work/<batchId>/`. The pre-render recipe file is `09-edit-recipe-final.json`. Renders land in `output/.work/<batchId>/renders/`. `output/` is gitignored.

Audio-library ingest, if you already use it:

```bash
npm run setup:playwright   # Chromium for Pixabay metadata
npm run ingest:pixabay-music
npm run ingest:pixabay-sfx
```

Tests (they check code paths, not that an edit is good):

```bash
npm test
npm run test:e2e
```

## Layout

| Path | What it is |
|------|------------|
| `inbox/` | Input video folders for `--input` |
| `output/` | Local batch artifacts. Not in git. |
| `src/` | CLI, pipeline steps, agents, validators, FFmpeg render |
| `python/` | Scene, vision, objects, face, audio scripts |
| `prompts/v2/` | Agent prompts the current CLI loads |
| `docs/` | Pipeline notes and `STATUS.md` |
