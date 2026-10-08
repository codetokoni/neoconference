// Clerk: who is signed in (globalThis.__who) and each user's plan and emails (globalThis.__users).
export * from "real:clerk";
export async function auth() { return { userId: globalThis.__who ?? null, sessionClaims: {} }; }
export async function currentUser() {
  const u = (globalThis.__users ?? {})[globalThis.__who];
  return u ? { id: globalThis.__who, emailAddresses: (u.emails ?? []).map((e) => ({ emailAddress: e })), primaryEmailAddress: { emailAddress: (u.emails ?? [])[0] } } : null;
}
export async function clerkClient() {
  return {
    users: {
      async getUser(id) {
        const u = (globalThis.__users ?? {})[id];
        if (!u) throw new Error("user not found");
        return { id, publicMetadata: u.plan ? { plan: u.plan } : {}, emailAddresses: (u.emails ?? []).map((e) => ({ emailAddress: e })) };
      },
    },
  };
}
