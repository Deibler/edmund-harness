import { cn } from "@/lib/cn";
import { type ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

const variantClass: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-accent/90 focus:ring-accent",
  secondary: "bg-card text-fg border border-border hover:border-muted focus:ring-muted",
  ghost: "bg-transparent text-fg hover:bg-card focus:ring-muted",
  danger: "bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20 focus:ring-danger",
};

const sizeClass: Record<Size, string> = {
  sm: "px-2.5 py-1 text-xs rounded-md",
  md: "px-3.5 py-1.5 text-sm rounded-lg",
  lg: "px-4 py-2 text-sm rounded-lg",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { className, variant = "secondary", size = "md", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bg disabled:opacity-50 disabled:cursor-not-allowed",
        variantClass[variant],
        sizeClass[size],
        className,
      )}
      {...rest}
    />
  );
});
