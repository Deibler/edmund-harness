// A one-shot program: embed once, print the result, and fall off the end.
// It must exit by itself although the embedding process is still loaded.
import { TransformersEmbedProvider } from "../../src/memory/embed-provider.ts";

const provider = new TransformersEmbedProvider(
  "test-model",
  2,
  new URL("./fake-embed-child.ts", import.meta.url),
);
const out = await provider.embed(["text 5"]);
console.log(out.vectors[0]?.[1]);
