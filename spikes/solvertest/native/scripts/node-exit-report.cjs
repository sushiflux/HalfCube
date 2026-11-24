// Preloaded with `node --require` for the WebAssembly driver: prints the peak resident set size of the Node
// process (WebAssembly heap + Node itself) on exit. The driver does not report memory.
process.on('exit', (code) => {
  const ru = process.resourceUsage();
  const mem = process.memoryUsage();
  process.stderr.write(
    `node-exit: code=${code} peak_rss_mb=${(ru.maxRSS / 1024).toFixed(1)} ` +
    `rss_mb=${(mem.rss / 1048576).toFixed(1)} external_mb=${(mem.external / 1048576).toFixed(1)} ` +
    `array_buffers_mb=${(mem.arrayBuffers / 1048576).toFixed(1)}\n`);
});
