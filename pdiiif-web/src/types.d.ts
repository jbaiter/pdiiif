declare module "*.svg" {
  // `string` since we're importing SVGs as their URLs with Vite
  const content: string;
  export default content;
}
