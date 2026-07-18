import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.js";

const log = createLogger("python");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const OPTIONAL_PACKAGES = [
  { module: "mlx_vlm", label: "mlx-vlm (Qwen2.5-VL)", visionRequired: true },
  { module: "torch", label: "torch (Florence-2)", objectsRequired: true },
  { module: "transformers", label: "transformers (Florence-2)", objectsRequired: true },
  { module: "cv2", label: "opencv-python-headless (face detection)", faceRequired: true },
  { module: "librosa", label: "librosa (audio analysis)", audioRequired: true },
  { module: "soundfile", label: "soundfile (audio analysis)", audioRequired: true },
  {
    module: "panns_inference",
    label: "panns_inference (audio event tagging)",
    audioRequired: false,
    audioEventTagging: true,
  },
];

export function resolvePythonScript(name) {
  return path.join(ROOT, "python", name);
}

export function resolvePythonBin(pythonBin = "python3") {
  if (process.env.PYTHON_VENV) {
    return path.join(process.env.PYTHON_VENV, "bin", "python3");
  }
  return pythonBin;
}

function validatePythonVenv(bin) {
  if (!process.env.PYTHON_VENV) {
    return;
  }

  const venvRoot = process.env.PYTHON_VENV;
  if (!fs.existsSync(venvRoot)) {
    throw new Error(`PYTHON_VENV nie istnieje: ${venvRoot}`);
  }

  if (!fs.existsSync(bin)) {
    throw new Error(`Brak interpretera Python w venv: ${bin}`);
  }
}

function runPythonImportCheck(bin, moduleName) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-c", `import ${moduleName}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      const error = new Error(stderr.trim() || `import ${moduleName} failed (code ${code})`);
      error.code = "IMPORT_FAILED";
      reject(error);
    });
  });
}

async function checkOptionalPackages(bin, { visionLive = false, objectsLive = false, audioLive = false, faceLive = false } = {}) {
  const warnings = [];

  for (const pkg of OPTIONAL_PACKAGES) {
    if (pkg.faceRequired && !faceLive) {
      continue;
    }

    if (pkg.audioEventTagging && !audioLive) {
      continue;
    }

    const required =
      (visionLive && pkg.visionRequired)
      || (objectsLive && pkg.objectsRequired)
      || (audioLive && pkg.audioRequired);

    try {
      await runPythonImportCheck(bin, pkg.module);
      log.detail(`Pakiet OK: ${pkg.label}`);
    } catch (error) {
      const message = `Brak pakietu ${pkg.label} (${error.message})`;
      if (required) {
        throw new Error(message);
      }
      if (faceLive && pkg.faceRequired) {
        const faceWarning = `${message} — detekcja twarzy użyje stub bbox zamiast OpenCV`;
        warnings.push(faceWarning);
        log.warn(faceWarning);
        continue;
      }
      if (audioLive && pkg.audioEventTagging) {
        const pannsWarning = `${message} — tagi editorial (śmiech, uderzenia) bez PANNs: eventDetectionMode "none"`;
        warnings.push(pannsWarning);
        log.warn(pannsWarning);
        continue;
      }
      warnings.push(message);
      log.warn(message);
    }
  }

  return warnings;
}

export function checkPythonPreflight({
  pythonBin = "python3",
  visionLive = false,
  objectsLive = false,
  audioLive = false,
  faceLive = false,
} = {}) {
  const bin = resolvePythonBin(pythonBin);
  validatePythonVenv(bin);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Python niedostępny (${bin}): ${error.message}`));
    });

    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(`Python --version zakończone kodem ${code}: ${stderr || stdout}`));
        return;
      }

      const versionText = (stdout || stderr).trim();
      const match = versionText.match(/Python (\d+)\.(\d+)/);
      if (!match) {
        reject(new Error(`Nie rozpoznano wersji Pythona: ${versionText}`));
        return;
      }

      const major = Number(match[1]);
      const minor = Number(match[2]);
      if (major < 3 || (major === 3 && minor < 9)) {
        reject(new Error(`Wymagany Python >= 3.9, znaleziono: ${versionText}`));
        return;
      }

      log.detail(`Python OK: ${versionText} (${bin})`);

      try {
        const warnings = await checkOptionalPackages(bin, { visionLive, objectsLive, audioLive, faceLive });
        resolve({ bin, version: versionText, warnings });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function runPythonScript(scriptName, input, { timeoutMs = 30 * 60 * 1000, pythonBin = "python3" } = {}) {
  const scriptPath = resolvePythonScript(scriptName);
  const bin = resolvePythonBin(pythonBin);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Python timeout (${scriptName}) po ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (text.trim()) {
        log.detail(text.trim());
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const killed = code === null ? ` (proces zabity${signal ? ` przez ${signal}` : ""} — często brak RAM)` : "";
        reject(new Error(stderr.trim() || `Python ${scriptName} zakończone kodem ${code}${killed}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Nieprawidłowy JSON z ${scriptName}: ${error.message}`));
      }
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}
