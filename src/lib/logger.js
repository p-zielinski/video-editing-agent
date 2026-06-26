export function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms} ms`;
  }

  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) {
    return `${totalSec} s`;
  }

  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min} min ${sec} s`;
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "?";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatVideoDuration(seconds) {
  if (!Number.isFinite(seconds)) {
    return "?";
  }

  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function timestamp() {
  return new Date().toLocaleTimeString("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function createLogger(scope = "agent") {
  const pipelineStartedAt = Date.now();
  let stepStartedAt = pipelineStartedAt;
  let heartbeat = null;

  function log(message) {
    console.log(`[${timestamp()}] [${scope}] ${message}`);
  }

  function detail(message) {
    console.log(`[${timestamp()}] [${scope}]   ${message}`);
  }

  function warn(message) {
    console.warn(`[${timestamp()}] [${scope}]   ⚠ ${message}`);
  }

  function banner(title) {
    log(`\n${title}`);
  }

  function step(label, current, total) {
    stopHeartbeat();
    stepStartedAt = Date.now();
    log(`\n▶ krok ${current}/${total}: ${label}`);
  }

  function stepDone(summary) {
    stopHeartbeat();
    const elapsed = formatDuration(Date.now() - stepStartedAt);
    log(`✓ krok zakończony (${elapsed})${summary ? ` — ${summary}` : ""}`);
  }

  function startHeartbeat(label, intervalSec = 20) {
    stopHeartbeat();
    const startedAt = Date.now();

    heartbeat = setInterval(() => {
      detail(`… ${label} — nadal trwa (${formatDuration(Date.now() - startedAt)})`);
    }, intervalSec * 1000);
  }

  function stopHeartbeat() {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  async function track(label, task, { heartbeatSec = 20 } = {}) {
    detail(`→ ${label}`);
    const startedAt = Date.now();

    if (heartbeatSec > 0) {
      startHeartbeat(label, heartbeatSec);
    }

    try {
      const result = await task();
      stopHeartbeat();
      detail(`← ${label} (${formatDuration(Date.now() - startedAt)})`);
      return result;
    } catch (error) {
      stopHeartbeat();
      throw error;
    }
  }

  function pipelineDone() {
    stopHeartbeat();
    log(`\n🏁 pipeline zakończony (łącznie: ${formatDuration(Date.now() - pipelineStartedAt)})`);
  }

  function pipelineFailed(error) {
    stopHeartbeat();
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[${timestamp()}] [${scope}] \n✗ błąd po ${formatDuration(Date.now() - pipelineStartedAt)}: ${message}`,
    );
  }

  return {
    log,
    detail,
    warn,
    banner,
    step,
    stepDone,
    track,
    pipelineDone,
    pipelineFailed,
    stopHeartbeat,
  };
}
