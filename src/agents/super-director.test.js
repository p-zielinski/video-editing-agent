import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSuperDirector } from "./super-director.js";
import { SuperDirectorPlanSchema } from "../schemas/super-director-plan.js";
import { createMockOpenAIClient, loadFixture } from "./test-helpers.js";
import { MODELS } from "./openai-client.js";

describe("super-director agent", () => {
  const abstraction = loadFixture("abstraction.json");
  const timelineIndex = loadFixture("timeline-index.json");
  const clipRegistry = [{ clipId: "clip01", sortIndex: 0, durationSec: 120 }];

  it("parses super director plan from mocked client", async () => {
    const mockPlan = {
      segmentOrder: ["seg001"],
      segmentPicks: [{ segmentId: "seg001", priority: 1, targetKeepRatio: 0.5 }],
      crossSegmentNotes: ["Zachowaj hook na początku"],
      shortsSources: ["seg001"],
      globalTheme: "vlog",
      excludedClips: [],
    };

    const client = createMockOpenAIClient([mockPlan], { captureRequests: true });
    const { plan, briefMetric } = await runSuperDirector(client, {
      abstraction,
      timelineIndex,
      clipRegistry,
      userContext: "vlog dzień 66",
      requiredFormats: ["16:9", "9:16"],
    });

    assert.equal(SuperDirectorPlanSchema.safeParse(plan).success, true);
    assert.equal(plan.segmentPicks[0].segmentId, "seg001");
    assert.equal(plan.crossSegmentNotes[0], "Zachowaj hook na początku");
    assert.equal(briefMetric.task, "super_director_route");
    assert.ok(briefMetric.estimatedTokens > 0);

    const requests = client.getCapturedRequests();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, MODELS.superDirector);
    const payload = JSON.parse(requests[0].messages[1].content);
    assert.equal(payload.task, "super_director_route");
    assert.ok(Array.isArray(payload.segmentCatalog));
  });

  it("coerces nested crossSegmentNotes from mocked GPT response", async () => {
    const mockPlan = {
      segmentOrder: ["seg001"],
      segmentPicks: [{ segmentId: "seg001", priority: 1 }],
      crossSegmentNotes: ["intro", ["bridge seg001", "bridge seg002"], "outro"],
      shortsSources: [],
      excludedClips: [],
    };

    const client = createMockOpenAIClient([mockPlan]);
    const { plan } = await runSuperDirector(client, {
      abstraction,
      timelineIndex,
      clipRegistry,
    });

    assert.deepEqual(plan.crossSegmentNotes, [
      "intro",
      "bridge seg001; bridge seg002",
      "outro",
    ]);
  });
});
