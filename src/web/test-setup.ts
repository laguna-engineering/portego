/**
 * Component tests need a DOM. Registering happy-dom here, rather than in a
 * global preload, keeps the browser globals out of the server tests.
 */

import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!("document" in globalThis)) {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
}

// Testing Library cleans up after itself when it finds a test framework it
// recognizes. It does not recognize bun:test, so the teardown is registered here.
const { cleanup } = await import("@testing-library/react");
afterEach(cleanup);

// The client opens a change stream on every signed-in page, and happy-dom has
// no EventSource. Installing the stub keeps a component test from reaching for
// a connection that does not exist.
const { StubEventSource } = await import("./testing.ts");
StubEventSource.install();
