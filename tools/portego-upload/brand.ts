/** The names a company's build of this tool replaces. generate.ts sets them at build time. */
export type Brand = {
  /** The product name people and Claude read, e.g. in tool titles. */
  name: string;
  /** Names the plugin, the MCP server, and the command (`<slug>-upload`), and the finished file's suffix. */
  slug: string;
  /** The npm package that starts the tool, for the messages that tell a person to run it. */
  packageName: string;
  /** The deployment to use when neither PORTEGO_ORIGIN nor `auth <origin>` names one. */
  origin?: string;
};

declare const PORTEGO_BRAND: Brand | undefined;

export const DEFAULT_BRAND: Brand = {
  name: "Portego",
  slug: "portego",
  packageName: "portego-upload",
};

// Replaced by the bundler's `define` in a company's build, and undeclared otherwise.
export const brand: Brand = typeof PORTEGO_BRAND === "undefined" ? DEFAULT_BRAND : PORTEGO_BRAND;
