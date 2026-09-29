// Ambient declarations for the text-file imports specification.ts uses to
// read credentials out of .env/.env.rel (`import envText from "../.env/.env.rel"
// with { type: "text" }`). Bombadil doesn't ship types for arbitrary
// extensions like these, so without this, tsc/editors report "Cannot find
// module" even though Bombadil's own bundler resolves it fine at test time.
declare module "*.env.rel" {
  const contents: string;
  export default contents;
}

declare module "*.env.build" {
  const contents: string;
  export default contents;
}
