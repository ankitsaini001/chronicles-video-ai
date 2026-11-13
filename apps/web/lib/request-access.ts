import { SITE } from "./site";

// "Request access" on the Access pending page (F10). No form or email service in V1: it opens the
// visitor's own email app with a short message to the team, who then add the email to the invite
// list (`npm run db -- invite add <email>`). The visitor's email is never put in a URL by us; they
// send from their own address, which is the one to invite.

export const REQUEST_ACCESS_SUBJECT = `Access request for ${SITE.name}`;

export const REQUEST_ACCESS_BODY = [
  "Hi team,",
  "",
  `I'd like access to ${SITE.name}.`,
  "",
  "Name:",
  "What I teach (subject / class):",
  "Instagram handle (optional):",
  "",
  "Please invite the email address I'm writing from.",
  "",
  "Thanks!",
].join("\n");

/** mailto: link to the team with the subject and message filled in. */
export function requestAccessHref(email: string = SITE.contactEmail): string {
  const query = `subject=${encodeURIComponent(REQUEST_ACCESS_SUBJECT)}&body=${encodeURIComponent(REQUEST_ACCESS_BODY)}`;
  return `mailto:${email}?${query}`;
}
