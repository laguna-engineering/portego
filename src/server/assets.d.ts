/** Bun reads these with `with { type: "text" }` and `with { type: "file" }`. */
declare module "*.css" {
  const text: string;
  export default text;
}
