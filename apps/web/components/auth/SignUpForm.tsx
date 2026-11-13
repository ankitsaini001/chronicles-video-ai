"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Button, Input, PasswordInput } from "@/components/ui";
import { AUTH_MESSAGES, SIGN_UP_LIMITS } from "@/lib/auth/messages";

// The sign-up form (Stitch "Sign up", docs/API.md A1). Checks the fields first, then sends
// name + email + password to /api/auth/sign-up/email ("confirm password" stays in the browser).
// Invited → signed in → /dashboard. Not invited → /access-pending.

type Field = "name" | "email" | "password" | "confirm";
type Errors = Partial<Record<Field, string>>;
type FormError = { message: string; loginLink?: boolean } | null;

const FIELD_ORDER: Field[] = ["name", "email", "password", "confirm"];
/** A light check; the server does the real one. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkFields(v: Record<Field, string>): Errors {
  const errors: Errors = {};
  const name = v.name.trim();
  if (name.length < 1 || name.length > SIGN_UP_LIMITS.nameMax) errors.name = AUTH_MESSAGES.INVALID_NAME;
  const email = v.email.trim();
  if (!EMAIL_SHAPE.test(email) || email.length > SIGN_UP_LIMITS.emailMax) errors.email = AUTH_MESSAGES.INVALID_EMAIL;
  if (v.password.length < SIGN_UP_LIMITS.passwordMin || v.password.length > SIGN_UP_LIMITS.passwordMax) errors.password = AUTH_MESSAGES.PASSWORD_LENGTH;
  else if (v.confirm !== v.password) errors.confirm = AUTH_MESSAGES.PASSWORDS_DIFFERENT;
  return errors;
}

export function SignUpForm() {
  const [values, setValues] = useState<Record<Field, string>>({ name: "", email: "", password: "", confirm: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<FormError>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const set = (field: Field) => (event: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [field]: event.target.value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  };

  function showErrors(next: Errors) {
    setErrors(next);
    const first = FIELD_ORDER.find((f) => next[f]);
    if (first) formRef.current?.querySelector<HTMLInputElement>(`#signup-${first}`)?.focus();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setFormError(null);
    const found = checkFields(values);
    if (Object.keys(found).length > 0) return showErrors(found);

    setBusy(true);
    let status = 0;
    let code = "";
    try {
      const response = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name: values.name.trim(), email: values.email.trim(), password: values.password }),
      });
      status = response.status;
      if (!response.ok) code = String(((await response.json().catch(() => ({}))) as { code?: unknown }).code ?? "");
    } catch {
      setBusy(false);
      setFormError({ message: "Couldn't reach the server. Check your internet connection and try again." });
      return;
    }

    if (status === 200) {
      // Signed in: the session cookie is set. A full page load so the server sees it.
      window.location.assign("/dashboard");
      return;
    }
    if (code === "NOT_ALLOWLISTED") {
      window.location.assign("/access-pending");
      return;
    }
    setBusy(false);
    switch (code) {
      case "INVALID_EMAIL":
        return showErrors({ email: AUTH_MESSAGES.INVALID_EMAIL });
      case "PASSWORD_TOO_SHORT":
      case "PASSWORD_TOO_LONG":
        return showErrors({ password: AUTH_MESSAGES.PASSWORD_LENGTH });
      case "USER_ALREADY_EXISTS":
        return setFormError({ message: AUTH_MESSAGES.USER_ALREADY_EXISTS, loginLink: true });
      case "TOO_MANY_ATTEMPTS":
        return setFormError({ message: AUTH_MESSAGES.TOO_MANY_ATTEMPTS });
      case "FORBIDDEN_ORIGIN":
        return setFormError({ message: AUTH_MESSAGES.FORBIDDEN_ORIGIN });
      case "INVALID_INPUT":
        return setFormError({ message: AUTH_MESSAGES.INVALID_INPUT });
      default:
        return setFormError({ message: AUTH_MESSAGES.INTERNAL });
    }
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      {formError && (
        <div role="alert" className="rounded-2xl border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-text">
          {formError.message}
          {formError.loginLink && (
            <>
              {" "}
              <Link href="/login" className="font-medium text-amber underline-offset-2 hover:underline">
                Log in
              </Link>
            </>
          )}
        </div>
      )}
      <Input
        id="signup-name"
        name="name"
        label="Name"
        placeholder="Your name"
        autoComplete="name"
        maxLength={SIGN_UP_LIMITS.nameMax}
        required
        value={values.name}
        onChange={set("name")}
        {...(errors.name ? { error: errors.name } : {})}
      />
      <Input
        id="signup-email"
        name="email"
        type="email"
        label="Email"
        placeholder="you@example.com"
        autoComplete="email"
        inputMode="email"
        maxLength={SIGN_UP_LIMITS.emailMax}
        required
        value={values.email}
        onChange={set("email")}
        {...(errors.email ? { error: errors.email } : {})}
      />
      <PasswordInput
        id="signup-password"
        name="password"
        label="Password"
        autoComplete="new-password"
        required
        value={values.password}
        onChange={set("password")}
        {...(errors.password ? { error: errors.password } : { helper: "8 to 128 characters" })}
      />
      <PasswordInput
        id="signup-confirm"
        name="confirm"
        label="Confirm password"
        autoComplete="new-password"
        required
        value={values.confirm}
        onChange={set("confirm")}
        {...(errors.confirm ? { error: errors.confirm } : {})}
      />
      <div className="pt-2">
        <Button type="submit" fullWidth disabled={busy} aria-busy={busy}>
          {busy ? "Creating account…" : "Create account"}
        </Button>
      </div>
    </form>
  );
}
