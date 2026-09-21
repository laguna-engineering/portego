/**
 * Development entry point. When `.env` points OIDC_ISSUER_URL at this
 * machine, the local issuer starts here first, because the server reads its
 * discovery document at startup and skips the provider when it cannot.
 */
import { localIssuerPort, startDevIssuer } from "./dev-issuer.ts";

const port = localIssuerPort();
const issuer = port === null ? null : await startDevIssuer(port);

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
