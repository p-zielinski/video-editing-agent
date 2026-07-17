# Voice engagement & delivery analysis

> Last updated: 2026-07-17
> Status: done

## Problem & goal

Detect flat vocal delivery (prosody) separately from recording quality; suggest and apply repairs: editorial pacing first, DSP polish second, pointwise modulation third.

## Key files

| Area | Path | Role |
|------|------|------|
| Python analysis | `python/delivery_analysis.py` | F0, loudness, pace, engagementScore |
| JS rollup | `src/lib/delivery-analysis.js` | hints, repair candidates |
| Pipeline | `src/pipeline/steps/audio-analysis.js`, `analysis-phase.js` | enrich after transcribe |
| DSP polish | `src/lib/audio-enhancement/dsp-polish.js` | podcast/engagement chain |
| Technique | `techniques/audio/voice_emphasis_boost.json` | pointwise emphasis |
| Resynthesis | `src/lib/voice-resynthesis/index.js` | consent-gated stub |
| Calibration | `data/delivery-calibration/README.md` | editor rating protocol |

## Verification

```bash
npm test -- src/lib/delivery-analysis.test.js src/lib/audio-enhancement/dsp-polish.test.js src/lib/voice-resynthesis/index.test.js
python3 python/delivery_analysis.py <<< '{"stub":true,"durationSec":30}'
```
