"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Button, Input, PasswordInput } from "@/components/ui";
import { AUTH_MESSAGES, SIGN_IN_LIMITS } from "@/lib/auth/messages";

// The log-in form (Stitch "Log in", docs/API.md A2). Sends email + password to
// /api/auth/sign-in/email. Success → /dashboard. A wrong email and a wrong password get the same
// message, so the form never tells whether an account exists.

type Field = "email" | "password";
type Errors = Partial<Record<Field, string>>;
type FormError = { message: string; contactLink?: boolean } | null;

/** A light check; the server does the real one. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENTER_PASSWORD = "Enter your password.";

function checkFields(v: Record<Field, string>): Errors {
  const errors: Errors = {};
  const email = v.email.trim();
  if (!EMAIL_SHAPE.test(email) || email.length > SIGN_IN_LIMITS.emailMax) errors.email = AUTH_MESSAGES.INVALID_EMAIL;
  if (v.password.length < 1) errors.password = ENTER_PASSWORD;
  return errors;
}

export function LoginForm() {
  const [values, setValues] = useState<Record<Field, string>>({ email: "", password: "" });
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
    const first = (["email", "password"] as const).find((f) => next[f]);
    if (first) formRef.current?.querySelector<HTMLInputElement>(`#login-${first}`)?.focus();
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
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: values.email.trim(), password: values.password }),
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
    setBusy(false);
    switch (code) {
      case "INVALID_EMAIL_OR_PASSWORD":
        setValues((v) => ({ ...v, password: "" }));
        formRef.current?.querySelector<HTMLInputElement>("#login-password")?.focus();
        return setFormError({ message: AUTH_MESSAGES.INVALID_EMAIL_OR_PASSWORD });
      case "INVALID_EMAIL":
        return showErrors({ email: AUTH_MESSAGES.INVALID_EMAIL });
      case "TOO_MANY_ATTEMPTS":
        return setFormError({ message: AUTH_MESSAGES.TOO_MANY_ATTEMPTS });
      case "ACCOUNT_SUSPENDED":
        return setFormError({ message: AUTH_MESSAGES.ACCOUNT_SUSPENDED, contactLink: true });
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
          {formError.contactLink && (
            <>
              {" "}
              <Link href="/contact" className="font-medium text-amber underline-offset-2 hover:underline">
                Contact us
              </Link>
            </>
          )}
        </div>
      )}
      <Input
        id="login-email"
        name="email"
        type="email"
        label="Email"
        placeholder="you@example.com"
        autoComplete="email"
        inputMode="email"
        maxLength={SIGN_IN_LIMITS.emailMax}
        required
        value={values.email}
        onChange={set("email")}
        {...(errors.email ? { error: errors.email } : {})}
      />
      <PasswordInput
        id="login-password"
        name="password"
        label="Password"
        autoComplete="current-password"
        maxLength={SIGN_IN_LIMITS.passwordMax}
        required
        value={values.password}
        onChange={set("password")}
        {...(errors.password ? { error: errors.password } : {})}
      />
      <div className="pt-3">
        <Button type="submit" fullWidth disabled={busy} aria-busy={busy}>
          {busy ? "Logging in…" : "Log in"}
        </Button>
      </div>
    </form>
  );
}
