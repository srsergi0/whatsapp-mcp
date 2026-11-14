// Must be the first import of every entry point.
// 1) stdout is the MCP wire for stdio: nothing else may ever write to it.
// 2) node:sqlite prints an ExperimentalWarning that is just noise for users.
const toStderr = (...a: unknown[]) => console.error(...a);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  console.error(`(node:${process.pid}) ${w.name}: ${w.message}`);
});

export {};
