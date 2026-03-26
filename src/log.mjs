export function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}
