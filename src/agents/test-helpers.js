import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export function loadFixture(name) {
  const filePath = path.join(FIXTURES_DIR, name);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function createMockOpenAIClient(responses, { captureRequests = false } = {}) {
  const queue = [...responses];
  const requests = [];

  const client = {
    chat: {
      completions: {
        create: async (options) => {
          if (captureRequests) {
            requests.push(options);
          }
          const next = queue.shift();
          if (next === undefined) {
            throw new Error("Mock OpenAI client: brak kolejnej odpowiedzi");
          }
          if (next instanceof Error) {
            throw next;
          }
          return {
            choices: [{ message: { content: JSON.stringify(next) } }],
          };
        },
      },
    },
  };

  if (captureRequests) {
    client.getCapturedRequests = () => requests;
  }

  return client;
}
