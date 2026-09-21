import react from "@vitejs/plugin-react";
import { type Connect, defineConfig } from "vite";

const apiTarget = `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? "3000"}`;
const appUrl = (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");

/**
 * The application lives on localhost and previews on 127.0.0.1, which is the
 * URL Vite prints. A sign-in started from 127.0.0.1 sets its state cookie
 * there and comes back to localhost without it. Anything but a preview asked
 * for on 127.0.0.1 goes to the application origin instead.
 */
const applicationHost = {
  name: "application-host",
  configureServer(server: { middlewares: Connect.Server }) {
    server.middlewares.use((req, res, next) => {
      const host = req.headers.host ?? "";
      const path = req.url ?? "/";
      if (host.startsWith("127.0.0.1") && !path.startsWith("/preview/")) {
        res.statusCode = 302;
        res.setHeader("location", `${appUrl}${path}`);
        res.end();
        return;
      }
      next();
    });
  },
};

// The dev server owns the browser origin and forwards API, auth, and health
// requests to Hono, so client code uses the same paths in both environments.
export default defineConfig({
  root: "src/web",
  plugins: [react(), applicationHost],
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // Anchored on the slash: a bare prefix would also catch the client's own
    // /api.ts module.
    proxy: {
      "^/api/": { target: apiTarget, changeOrigin: true },
      "^/auth/": { target: apiTarget, changeOrigin: true },
      "/healthz": { target: apiTarget, changeOrigin: true },
      // Previews keep the browser's Host header, because the server uses it to
      // tell the content host from the application host. In development the
      // two are localhost and 127.0.0.1, which the browser treats as separate
      // origins and gives separate cookie jars.
      "^/preview/": { target: apiTarget, changeOrigin: false },
    },
  },
});
