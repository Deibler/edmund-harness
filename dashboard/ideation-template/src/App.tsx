import { Separator } from "@/components/ui/separator";

/**
 * Placeholder. Each page replaces this file entirely (see DESIGN.md): the
 * first screen is the tool itself, built from the person's own questions.
 */
export function App() {
  return (
    <main className="mx-auto max-w-xl px-5 py-10">
      <h1 className="font-heading text-3xl">Page title</h1>
      <p className="mt-2 text-muted-foreground">One plain sentence about what this does.</p>
      <Separator className="my-6" />
      <p className="text-sm text-muted-foreground">Made by Edmund.</p>
    </main>
  );
}
