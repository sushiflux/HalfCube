// "Don't show this at the next start": the one preference of the welcome screen (provisional storage, see prefs/).
import { preferences, type Preferences } from "../../prefs/preferences.ts";

export const welcomeHiddenKey = "welcome.hidden";

/** True once the user ticked "Don't show this at the next start". Until then the welcome screen appears at every start. */
export function isWelcomeHidden(store: Pick<Preferences, "get"> = preferences): boolean {
  return store.get(welcomeHiddenKey) === "1";
}

export function setWelcomeHidden(hidden: boolean, store: Pick<Preferences, "set" | "remove"> = preferences): void {
  if (hidden) store.set(welcomeHiddenKey, "1");
  else store.remove(welcomeHiddenKey);
}
