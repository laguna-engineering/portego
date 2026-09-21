/** Vite and Bun both resolve an image import to its URL. */
declare module "*.png" {
  const url: string;
  export default url;
}
