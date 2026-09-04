import { cn } from "@/lib/utils";

/** The mark: lowercase serif "edmund" in ink with the amber spark. */
export function Wordmark({ className, size = "md" }: { className?: string; size?: "md" | "lg" }) {
  const text = size === "lg" ? "text-4xl" : "text-[1.45rem]";
  const spark = size === "lg" ? "size-4 -mt-5" : "size-2.5 -mt-3";
  return (
    <span className={cn("inline-flex items-start select-none", className)} aria-label="Edmund">
      <span
        className={cn("font-heading leading-none text-ink", text)}
        style={{ letterSpacing: "-0.02em" }}
      >
        edmund
      </span>
      <svg
        viewBox="0 0 24 24"
        className={cn("ml-0.5 shrink-0 text-amber", spark)}
        aria-hidden="true"
      >
        <path
          d="M12 1.5C12.9 6.6 17.4 11.1 22.5 12 17.4 12.9 12.9 17.4 12 22.5 11.1 17.4 6.6 12.9 1.5 12 6.6 11.1 11.1 6.6 12 1.5Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}
