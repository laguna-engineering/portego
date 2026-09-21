/**
 * Development entry point. When `.env` points OIDC_ISSUER_URL at this
 * machine, the local issuer starts here first, because the server reads its
 * discovery document at startup and skips the provider when it cannot.
 *
 * The schema is applied next, so a new clone and a pull that adds a migration
 * both start with a database the server can use. Production never does this:
 * deployment migrates as its own step.
 */
import { migrate } from "../src/server/migrate.ts";
import { localIssuerPort, startDevIssuer } from "./dev-issuer.ts";

const port = localIssuerPort();
const issuer = port === null ? null : await startDevIssuer(port);

// After the issuer: the migration builds the auth configuration, which reads
// the issuer's discovery document.
await migrate();

const processes = Bun.spawn(
  [
    "bunx",
    "concurrently",
    "-k",
    "-n",
    "server,web",
    "-c",
    "blue,magenta",
    "bun run dev:server",
    "bun run dev:web",
  ],
  { stdio: ["inherit", "inherit", "inherit"] },
);

const stop = () => {
  processes.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(`Open ${process.env.APP_URL ?? "http://localhost:5173"} (not the address Vite prints)`);

const code = await processes.exited;
issuer?.stop();
process.exit(code);
