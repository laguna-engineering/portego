/** The deployment's name. The server writes it into index.html, so it is there before sign-in. */
export function appName(): string {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="application-name"]')?.content || "Portego"
  );
}
