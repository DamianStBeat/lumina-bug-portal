// SIGTERM path (systemd stop/restart): a running event tick is let finish, so a message it just posted gets its
// cursor written and is not posted again after the restart. The wait is capped: systemd kills after its own timeout.

/** Awaits `stop` for at most `capMs`, then `destroy`; neither a rejection nor a hang stops the shutdown. */
export async function stopThenDestroy(stop: () => Promise<void>, destroy: () => Promise<void>, capMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, capMs);
  });
  try {
    // A failed tick was already logged by the poller; here only its end matters.
    await Promise.race([Promise.resolve().then(stop).catch(() => undefined), cap]);
  } finally {
    clearTimeout(timer);
  }
  // Destroying an already closed client rejects; the process is exiting either way.
  await Promise.resolve().then(destroy).catch(() => undefined);
}
