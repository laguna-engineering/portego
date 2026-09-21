import { useEffect } from "react";

export type McpLoginProps = {
  /** The signed OAuth query this page has to hand back to the authorization endpoint. */
  query: string;
};

/**
 * Where the authorization endpoint sends a browser without a session. The
 * signed-out case renders the ordinary sign-in page, so this component only
 * has to resume the flow once a session exists.
 */
export function McpLogin({ query }: McpLoginProps) {
  useEffect(() => {
    window.location.assign(`/api/auth/oauth2/authorize${query}`);
  }, [query]);

  return (
    <section className="signin">
      <h1>Continuing</h1>
      <p>Returning you to the authorization request...</p>
    </section>
  );
}
