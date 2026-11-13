import { UserMenu } from "@/components/auth/UserMenu";
import { Button } from "@/components/ui";
import { getSessionUserOrNull } from "@/lib/auth/session";

// Right side of the public header (F09): signed in → the user's name and menu; signed out → "Log in".
// Read on the server for every request, so after logging out the name is gone on the next page.

export async function HeaderAccount() {
  const user = await getSessionUserOrNull();
  if (user) return <UserMenu name={user.name} email={user.email} />;
  return (
    <Button href="/login" size="sm">
      Log in
    </Button>
  );
}

/** Same size as the "Log in" button, shown for the moment the session is being read. */
export function HeaderAccountPlaceholder() {
  return <div aria-hidden="true" className="h-11 w-24" />;
}
