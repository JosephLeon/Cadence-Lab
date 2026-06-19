# Design: splice classification reuse

**Status:** deferred (not implemented). Captured here so the next contributor
isn't designing from scratch.

## Problem

When a user assembles a splice timeline from sub-ranges of multiple source
videos, renders it to a single MP4, and then says *"Cadence, remove every
sniffle from this"*, the obvious-but-wrong move is to treat the spliced
MP4 as a new source. That triggers the full pipeline (analyze + classify
+ events scan) on the rendered audio, charging fresh Anthropic and Groq
tokens for transcription/classification work we already did on each
source clip independently.

The right move is to recognize that we have:
- Original analyses (`<project>/artifacts/<source>.analysis.json`) for
  every source clip in the timeline
- Optional audio-event scans (`<source>.events.json`) for any source the
  user already scanned
- Optional visual indexes (`<source>.frames.npz`) likewise

So for splice-aware Cadence queries, the answer is to walk each splice
clip, look up the corresponding artifacts for its source, *translate
timestamps from source-time to splice-output-time*, and produce a
synthetic merged view that Cadence's tools can read from. Zero new
tokens; everything is already on disk.

## What needs to change

### Backend

1. **A "splice digest" artifact builder.** Given a `SpliceState.timeline`,
   walk each clip and emit a merged view that mirrors the shape of the
   per-source artifacts (`pauses`, `fillers`, `audio_events`) but with
   timestamps offset by `cumulative_output_time - source_clip_start`.
   Probably lives in a new `src/cadence_lab/splice_artifacts.py`.

2. **`/cadence/query` accepts splice context.** When the active view is
   the splice tab, the digest builder above runs, the merged artifacts
   replace per-source `list_pauses` / `list_fillers` / `list_audio_events`
   tool results, and any propose actions (`add_custom_cut`,
   `create_highlight_clip`) are recorded against the splice timeline,
   not against a source.

3. **Custom cuts in the splice render.** Today
   [`splice_render`](../src/cadence_lab/renderer.py) does pure ffmpeg
   concat with no cut layer. Need to add a per-clip "cuts" pass that
   trims sub-ranges out of each splice clip before concatenation, so
   "remove the sniffle at 0:34 of splice output" actually modifies the
   final MP4.

### Frontend

4. **Splice-time custom cuts in state.** The `useSplicing` store needs
   a `customCuts: CustomCut[]` field per timeline (or per-clip) so the
   user / Cadence can stage cuts before render.

5. **Cadence dispatcher routes to splice ops in splice view.** The
   existing `applyCadenceAction` is source-centric (mutates
   `useProject.activeMedia`). When the active view is splice, the same
   action types need to mutate `useSplicing` instead.

6. **UI for the splice cuts.** Same audition / preview / remove
   affordances as the AI tab's custom-cut list, but bound to the splice
   timeline.

## Hard parts

- **Audio event timestamps span clip boundaries**: a sniffle whose end
  falls in the next splice clip needs careful range math. Easiest fix:
  drop any event that straddles a boundary; document it.
- **The visual index is per-source.** Visual search across a splice
  ("find the part of the splice where the dog appears") requires
  searching each source's index separately and aggregating with
  timestamp translation. Plausible, just more code.
- **Re-rendering the splice with cuts changes the timeline shape**, so
  output-time-to-source-time math has to re-run on every render. State
  needs to be reactive.

## Why deferred

The pattern below it (the lineage prompt) covers the common case: most
users producing a splice want to iterate by tweaking the splice itself,
not by piping the rendered MP4 back through the AI pipeline. The lineage
prompt prevents the most expensive footgun (~$0.55 in tokens per
accidental round-trip). Splice-aware Cadence is the next level of
polish and worth a few days of focused work, not a sprinkle into an
already-large PR.

## Quick recap of what *does* work today

- Single-source AI tab: full pipeline runs once, then custom cuts +
  overrides + audio settings re-render for free.
- Splice render: assembles clips, no AI calls on render.
- Audio-only render: applies enhancement, denoise, ducking with zero
  AI calls.
- Lineage prompt: blocks the "treat a render as a source" footgun.
- Content-hash cache: re-importing the same audio skips the Whisper
  call.

The gap this design closes is specifically *"talk to Cadence about a
spliced output"*. Until built, the UX answer is: ask Cadence about the
individual sources before splicing, not after.
