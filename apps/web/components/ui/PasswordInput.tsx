"use client";

import { useState, type ComponentPropsWithoutRef } from "react";
import { Icon } from "./Icon";
import { Input } from "./Input";

// Password field with a show/hide button inside it (Stitch "Sign up" / "Log in").
// The button says what it will do ("Show password" / "Hide password") for screen readers and is a
// 44×44 touch target. Same props as Input, minus `type` and `trailing`.

type PasswordInputProps = Omit<ComponentPropsWithoutRef<typeof Input>, "type" | "trailing">;

export function PasswordInput({ label, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <Input
      {...props}
      label={label}
      type={visible ? "text" : "password"}
      trailing={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-controls={props.id}
          className="flex size-11 cursor-pointer items-center justify-center rounded-xl text-muted transition hover:text-text focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-gold-cream"
        >
          <Icon name={visible ? "eyeOff" : "eye"} className="size-5" />
        </button>
      }
    />
  );
}
