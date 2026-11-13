import { SITE } from "../site";

// The words people see for each sign-up / login problem (docs/API.md §3.2). One place, used by the
// server (error bodies) and by the forms. Safe to import in the browser (no server code here).

export const AUTH_MESSAGES = {
  NOT_ALLOWLISTED: `${SITE.name} is in private beta — request access`,
  USER_ALREADY_EXISTS: "An account with this email already exists. Log in instead.",
  PASSWORD_LENGTH: "Use 8 to 128 characters.",
  INVALID_EMAIL: "Enter a valid email address.",
  INVALID_NAME: "Enter your name (up to 80 characters).",
  PASSWORDS_DIFFERENT: "The two passwords don't match.",
  INVALID_EMAIL_OR_PASSWORD: "Email or password is incorrect",
  ACCOUNT_SUSPENDED: `Your account is paused. Contact the ${SITE.name} team.`,
  TOO_MANY_ATTEMPTS: "Too many attempts. Please wait 15 minutes and try again.",
  FORBIDDEN_ORIGIN: "Please reload the page and try again.",
  INVALID_INPUT: "Something in the form isn't right. Please check it and try again.",
  INTERNAL: "Something went wrong on our side. Please try again.",
} as const;

/** Field limits shared by the form and the server (API.md A1). */
export const SIGN_UP_LIMITS = { nameMax: 80, emailMax: 254, passwordMin: 8, passwordMax: 128 } as const;

/** Field limits for log in (API.md A2). */
export const SIGN_IN_LIMITS = { emailMax: 254, passwordMax: 128 } as const;
