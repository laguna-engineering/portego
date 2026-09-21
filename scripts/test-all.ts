/**
 * Runs every test suite and enforces two rules CI depends on: a failing test
 * fails the run, and so does a skipped one. A suite that quietly stops running
 * a test is the same problem as a suite that never had it.
 *
 *   bun run test:ci
 */
const SUITES = [
  { name: "server", command: ["bun", "test", "src/server"] },
  { name: "web", command: ["bun", "test", "--preload", "./src/web/test-setup.ts", "src/web"] },
  { name: "tools", command: ["bun", "test", "tools"] },
  { name: "browser", command: ["bun", "test", "e2e"] },
];

const SKIPPED = /^\s*(\d+)\s+(skip|todo)/gm;
/**
 * Bun prints a skip line only when something was skipped, so an absent line
 * means nothing was. That reading holds only while the summary format is the
 * one below; if it ever changes, the skip rule would pass every suite without
 * checking anything.
 */
const SUMMARY = /^\s*\d+\s+(?:pass|fail)\b/m;

let failed = false;

for (const suite of SUITES) {
  console.log(`\n=== ${suite.name} ===`);
  const process_ = Bun.spawn(suite.command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
  ]);
  const output = `${stdout}${stderr}`;
  console.log(output);

  if ((await process_.exited) !== 0) {
    console.error(`${suite.name}: tests failed`);
    failed = true;
  }

  if (!SUMMARY.test(output)) {
    console.error(`${suite.name}: no test summary found. The skip check cannot read this output.`);
    failed = true;
  }

  for (const match of output.matchAll(SKIPPED)) {
    if (Number(match[1]) > 0) {
      console.error(`${suite.name}: ${match[1]} ${match[2]}ped tests. Every test has to run.`);
      failed = true;
    }
  }
}

process.exit(failed ? 1 : 0);
