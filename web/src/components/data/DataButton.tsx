import { type ButtonHTMLAttributes, forwardRef } from "react";
import { Slot } from "@radix-ui/react-slot";

import "../../styles/data.css";

export type DataButtonVariant = "default" | "outline" | "ghost" | "destructive";
export type DataButtonSize = "default" | "sm" | "icon";

export interface DataButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: DataButtonVariant;
  size?: DataButtonSize;
  /** Render the child (for example a router Link) with the button styling. */
  asChild?: boolean;
}

/**
 * Token-styled button for the Data section. Same props as `ui/Button`, which
 * the Data screens were first written against, but styled with the theme
 * tokens directly: `ui/Button` takes its colors and padding from Tailwind
 * utilities, and those lose to the unlayered `* { padding: 0 }` reset in
 * global.css and have no color mapping under the default `nex-shell` theme.
 */
export const Button = forwardRef<HTMLButtonElement, DataButtonProps>(
  (
    {
      variant = "default",
      size = "default",
      asChild = false,
      className,
      type,
      ...props
    },
    ref,
  ) => {
    const classes = [
      "data-btn",
      `data-btn--${variant}`,
      `data-btn--size-${size}`,
      className,
    ]
      .filter(Boolean)
      .join(" ");
    if (asChild) {
      return <Slot ref={ref} className={classes} {...props} />;
    }
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={classes}
        {...props}
      />
    );
  },
);
Button.displayName = "DataButton";
