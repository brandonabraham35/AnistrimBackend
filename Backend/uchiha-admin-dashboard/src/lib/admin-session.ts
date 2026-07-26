const KEY = "uchiha-admin";

export function signIn(name: string) {
  if (typeof window !== "undefined") sessionStorage.setItem(KEY, name);
}

export function signOut() {
  if (typeof window !== "undefined") sessionStorage.removeItem(KEY);
}

export function currentAdmin(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(KEY);
}