import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyCreativeMoments } from "./ffmpeg-creative.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("ffmpeg-creative", () => {
  it("emits TECHNIQUE_DEFERRED_CONCAT for concat-boundary crossfade", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-creative-deferred-"));
    const inputPath = path.join(tmpDir, "in.mp4");
    const outputPath = path.join(tmpDir, "out.mp4");
    fs.writeFileSync(inputPath, "stub");

    try {
      const { warnings } = await applyCreativeMoments(inputPath, outputPath, {
        moments: [
          { techniqueId: "crossfade", outputStartSec: 1, outputEndSec: 3 },
        ],
        encodeProfile: { videoCodec: "libx264", preset: "ultrafast", crf: 23 },
        dimensions: { width: 1920, height: 1080 },
      });

      const deferred = warnings.filter((w) => w.code === "TECHNIQUE_DEFERRED_CONCAT");
      assert.equal(deferred.length, 1);
      assert.equal(deferred[0].techniqueId, "crossfade");
      assert.ok(deferred[0].message.includes("granicy segmentów"));
      assert.ok(fs.existsSync(outputPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not defer cut_on_beat handled in concat pass", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-creative-cut-beat-"));
    const inputPath = path.join(tmpDir, "in.mp4");
    const outputPath = path.join(tmpDir, "out.mp4");
    fs.writeFileSync(inputPath, "stub");

    try {
      const { warnings } = await applyCreativeMoments(inputPath, outputPath, {
        moments: [
          { techniqueId: "cut_on_beat", outputStartSec: 2, outputEndSec: 3 },
        ],
        encodeProfile: { videoCodec: "libx264", preset: "ultrafast", crf: 23 },
        dimensions: { width: 1920, height: 1080 },
      });

      const deferred = warnings.filter((w) => w.code === "TECHNIQUE_DEFERRED_CONCAT");
      assert.equal(deferred.length, 0);
      assert.ok(fs.existsSync(outputPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not mark dip_to_black as unsupported", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-creative-dip-"));
    const inputPath = path.join(tmpDir, "in.mp4");
    const outputPath = path.join(tmpDir, "out.mp4");
    fs.writeFileSync(inputPath, "stub");

    try {
      const { warnings } = await applyCreativeMoments(inputPath, outputPath, {
        moments: [
          {
            techniqueId: "dip_to_black",
            outputStartSec: 5,
            outputEndSec: 5.6,
            params: { durationSec: 0.6 },
          },
        ],
        encodeProfile: { videoCodec: "libx264", preset: "ultrafast", crf: 23 },
        dimensions: { width: 1920, height: 1080 },
      });

      const unsupported = warnings.filter((w) => w.code === "TECHNIQUE_UNSUPPORTED");
      assert.equal(unsupported.length, 0);
      assert.ok(fs.existsSync(outputPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not mark whip_pan as unsupported", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-creative-whip-"));
    const inputPath = path.join(tmpDir, "in.mp4");
    const outputPath = path.join(tmpDir, "out.mp4");
    fs.writeFileSync(inputPath, "stub");

    try {
      const { warnings } = await applyCreativeMoments(inputPath, outputPath, {
        moments: [
          {
            techniqueId: "whip_pan",
            outputStartSec: 2,
            outputEndSec: 2.2,
            params: { direction: "left", durationSec: 0.2 },
          },
        ],
        encodeProfile: { videoCodec: "libx264", preset: "ultrafast", crf: 23 },
        dimensions: { width: 1920, height: 1080 },
      });

      const unsupported = warnings.filter((w) => w.code === "TECHNIQUE_UNSUPPORTED");
      assert.equal(unsupported.length, 0);
      assert.ok(fs.existsSync(outputPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not mark match_cut as unsupported", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-creative-match-"));
    const inputPath = path.join(tmpDir, "in.mp4");
    const outputPath = path.join(tmpDir, "out.mp4");
    fs.writeFileSync(inputPath, "stub");

    try {
      const { warnings } = await applyCreativeMoments(inputPath, outputPath, {
        moments: [
          {
            techniqueId: "match_cut",
            outputStartSec: 8,
            outputEndSec: 8.2,
            params: { matchType: "motion" },
          },
        ],
        encodeProfile: { videoCodec: "libx264", preset: "ultrafast", crf: 23 },
        dimensions: { width: 1920, height: 1080 },
      });

      const unsupported = warnings.filter((w) => w.code === "TECHNIQUE_UNSUPPORTED");
      assert.equal(unsupported.length, 0);
      assert.ok(fs.existsSync(outputPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not defer cut_mid_sentence at segment boundary", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-creative-cms-"));
    const inputPath = path.join(tmpDir, "in.mp4");
    const outputPath = path.join(tmpDir, "out.mp4");
    fs.writeFileSync(inputPath, "stub");

    try {
      const segments = [
        { outputStartSec: 0, outputEndSec: 30 },
        { outputStartSec: 30, outputEndSec: 60 },
      ];
      const { warnings } = await applyCreativeMoments(inputPath, outputPath, {
        moments: [
          {
            techniqueId: "cut_mid_sentence",
            outputStartSec: 30.05,
            outputEndSec: 30.2,
            params: { energy: "medium" },
          },
        ],
        segments,
        encodeProfile: { videoCodec: "libx264", preset: "ultrafast", crf: 23 },
        dimensions: { width: 1920, height: 1080 },
      });

      const deferred = warnings.filter((w) => w.code === "TECHNIQUE_DEFERRED_CONCAT");
      assert.equal(deferred.length, 0);
      const ack = warnings.find((w) => w.code === "CUT_MID_SENTENCE_ACK");
      assert.ok(ack, "expected CUT_MID_SENTENCE_ACK at segment join");
      assert.ok(fs.existsSync(outputPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("emits TECHNIQUE_DELEGATED_GRAPHICS for hook_title_overlay", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-creative-"));
    const inputPath = path.join(tmpDir, "in.mp4");
    const outputPath = path.join(tmpDir, "out.mp4");
    fs.writeFileSync(inputPath, "stub");

    try {
      const { warnings } = await applyCreativeMoments(inputPath, outputPath, {
        moments: [
          { techniqueId: "hook_title_overlay", outputStartSec: 0, outputEndSec: 2 },
        ],
        encodeProfile: { videoCodec: "libx264", preset: "ultrafast", crf: 23 },
        dimensions: { width: 1920, height: 1080 },
      });

      const delegated = warnings.find(
        (w) => w.techniqueId === "hook_title_overlay" && w.code === "TECHNIQUE_DELEGATED_GRAPHICS",
      );
      assert.ok(delegated, "expected hook_title_overlay to delegate to graphics pass");
      assert.ok(fs.existsSync(outputPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not mark color_desaturate as unsupported and builds eq filter", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-creative-color-desat-"));
    const inputPath = path.join(tmpDir, "in.mp4");
    const outputPath = path.join(tmpDir, "out.mp4");
    fs.writeFileSync(inputPath, "stub");

    try {
      const { warnings } = await applyCreativeMoments(inputPath, outputPath, {
        moments: [
          {
            techniqueId: "color_desaturate",
            outputStartSec: 6,
            outputEndSec: 9,
            params: { amount: 1 },
          },
        ],
        encodeProfile: { videoCodec: "libx264", preset: "ultrafast", crf: 23 },
        dimensions: { width: 1920, height: 1080 },
      });

      const unsupported = warnings.filter((w) => w.code === "TECHNIQUE_UNSUPPORTED");
      const noOp = warnings.filter((w) => w.code === "TECHNIQUE_NO_OP");
      assert.equal(unsupported.length, 0);
      assert.equal(noOp.length, 0);
      assert.ok(fs.existsSync(outputPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not mark color_saturation_boost as unsupported", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-creative-color-boost-"));
    const inputPath = path.join(tmpDir, "in.mp4");
    const outputPath = path.join(tmpDir, "out.mp4");
    fs.writeFileSync(inputPath, "stub");

    try {
      const { warnings } = await applyCreativeMoments(inputPath, outputPath, {
        moments: [
          {
            techniqueId: "color_saturation_boost",
            outputStartSec: 12,
            outputEndSec: 14,
            params: { boost: 0.15 },
          },
        ],
        encodeProfile: { videoCodec: "libx264", preset: "ultrafast", crf: 23 },
        dimensions: { width: 1920, height: 1080 },
      });

      const unsupported = warnings.filter((w) => w.code === "TECHNIQUE_UNSUPPORTED");
      const noOp = warnings.filter((w) => w.code === "TECHNIQUE_NO_OP");
      assert.equal(unsupported.length, 0);
      assert.equal(noOp.length, 0);
      assert.ok(fs.existsSync(outputPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
