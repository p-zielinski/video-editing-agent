import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapLabelToEditorialTag,
  enrichAudioEvents,
  rollupEditorialTags,
  topEditorialTagNames,
} from "./audio-event-tags.js";

describe("audio-event-tags", () => {
  it("maps AudioSet labels to editorial tags", () => {
    assert.deepEqual(mapLabelToEditorialTag("Screaming"), { tag: "scream", category: "reaction" });
    assert.deepEqual(mapLabelToEditorialTag("Laughter"), { tag: "laughter", category: "reaction" });
    assert.deepEqual(mapLabelToEditorialTag("Squeak"), { tag: "squeak", category: "foley" });
    assert.equal(mapLabelToEditorialTag("Unknown hum"), null);
  });

  it("enriches events and rolls up clip-level tags", () => {
    const events = enrichAudioEvents([
      { startSec: 1, endSec: 2, label: "Speech", score: 0.9 },
      { startSec: 5, endSec: 5.5, label: "Laughter", score: 0.8 },
      { startSec: 10, endSec: 10.3, label: "Laughter", score: 0.7 },
    ]);

    assert.equal(events[0].editorialTag, "speech");
    const rolled = rollupEditorialTags(events);
    assert.equal(rolled.find((t) => t.tag === "laughter")?.count, 2);
    assert.deepEqual(topEditorialTagNames(rolled), ["speech", "laughter"]);
  });
});
