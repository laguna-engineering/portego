import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // Shown on the sign-in page and by the OAuth consent screen.
    APP_NAME: z.string().min(1).default("Portego"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    // hono/bun strips a leading slash and resolves from the working directory,
    // so an absolute value would answer every client route with 404.
    CLIENT_DIST: z
      .string()
      .min(1)
      .refine((value) => !value.startsWith("/"), "must be relative to the working directory")
      .default("dist/client"),
    SESSION_SECRET: z.string().min(32).optional(),
    // The public origin of the application. OAuth callback URLs are built from
    // it, so it must match what the browser used, not what the server bound to.
    APP_URL: z.url().optional(),
    // The origin that serves artifact previews. It must be a different host
    // from APP_URL: that separation is what keeps uploaded HTML away from
    // application cookies. Development uses 127.0.0.1, which the browser
    // treats as a different host from localhost.
    CONTENT_URL: z.url().optional(),
    // SQLite and artifact files live here. Production uses
    // /var/lib/portego.
    DATA_DIR: z.string().min(1).default("data"),
    // Largest artifact an upload may carry. 5 MiB by default.
    ARTIFACT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .default(5 * 1024 * 1024),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    if (!env.SESSION_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["SESSION_SECRET"],
        message: "is required when NODE_ENV=production",
      });
    }
    if (!env.APP_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_URL"],
        message: "is required when NODE_ENV=production, for example https://share.acme.example",
      });
    }
    if (!env.CONTENT_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["CONTENT_URL"],
        message:
          "is required when NODE_ENV=production, for example https://content.share.acme.example",
      });
    }
  })
  .transform((env) => ({
    ...env,
    // Development serves the browser from Vite, which proxies /api to Hono.
    APP_URL: (env.APP_URL ?? "http://localhost:5173").replace(/\/+$/, ""),
    CONTENT_URL: (env.CONTENT_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, ""),
  }))
  .superRefine((env, ctx) => {
    if (new URL(env.APP_URL).host === new URL(env.CONTENT_URL).host) {
      ctx.addIssue({
        code: "custom",
        path: ["CONTENT_URL"],
        message: "must be a different host from APP_URL, or previews are not isolated",
      });
    }
  });

export type Env = z.infer<typeof schema>;

export type EnvSource = Record<string, string | undefined>;

/** Parses and validates environment variables. Throws when a value is missing or malformed. */
export function parseEnv(source: EnvSource): Env {
  // Bun reads `KEY=` from .env as an empty string. Treat it as absent so defaults apply.
  const set = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const result = schema.safeParse(set);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
