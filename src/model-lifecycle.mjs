// Queue-local model lifecycle for a resource-constrained Mac.
// Aegis unloads its configured models shortly after the final queued turn,
// rather than leaving Kev warmed for minutes after an answer.
export function createModelScheduler({
  readSettings,
  unload,
  report = (message) => console.warn('[aegis] ' + message),
  releaseDelayMs = 800,
  retryDelayMs = 30000
}) {
  let work = Promise.resolve();
  let pending = 0;
  let closing = false;
  let timer = null;
  let retryTimer = null;
  let released = true;

  function clearReleaseTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function clearRetryTimer() {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRelease(delay = releaseDelayMs) {
    if (closing || pending !== 0 || released) return;
    clearReleaseTimer();
    timer = setTimeout(() => {
      timer = null;
      if (closing || pending !== 0 || released) return;
      // Serialize cleanup with any request already submitted. A subsequent
      // prompt can never race our own model-unload operations.
      const cleanup = work.then(async () => {
        if (closing || pending !== 0 || released) return;
        const settings = await readSettings();
        if (!settings.autoUnload) {
          released = true; // explicit user preference: retain models
          return;
        }
        let failed = false;
        for (const [name, type] of [
          [settings.llmModel, 'generator'],
          [settings.kevModel, 'decision']
        ]) {
          try {
            await unload(settings, name, type);
          } catch (error) {
            failed = true;
            report('Unable to unload ' + name + ': ' + error.message);
          }
        }
        released = !failed;
        if (failed && !closing && pending === 0) {
          clearRetryTimer();
          retryTimer = setTimeout(() => scheduleRelease(0), retryDelayMs);
          retryTimer.unref?.();
        }
      });
      work = cleanup.catch(error => {
        released = false;
        report('Model cleanup failed: ' + error.message);
        if (!closing && pending === 0) {
          clearRetryTimer();
          retryTimer = setTimeout(() => scheduleRelease(0), retryDelayMs);
          retryTimer.unref?.();
        }
      });
    }, delay);
    timer.unref?.();
  }

  function enqueue(job) {
    if (closing) return Promise.reject(new Error('Aegis is closing.'));
    pending++;
    released = false;
    clearReleaseTimer();
    clearRetryTimer();
    const next = work.then(job);
    work = next.catch(() => undefined);
    const finished = () => {
      pending--;
      if (pending === 0) scheduleRelease();
    };
    next.then(finished, finished);
    return next;
  }

  function close() {
    closing = true;
    clearReleaseTimer();
    clearRetryTimer();
  }

  return { enqueue, close };
}
