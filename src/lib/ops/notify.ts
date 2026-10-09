// src/lib/ops/notify.ts
//
// Who hears about an ops alert: the platform owner (every verified owner
// address in PLATFORM_OWNER_EMAILS that has an account) and every active
// administrator whose role holds ops:read. By email (Resend) and in the
// app's notification bell. Awaited by the caller, never thrown from.

import { clerkClient } from "@clerk/nextjs/server";
import { ownerEmails, verifiedEmails, type ClerkEmailish } from "@/lib/admin/owner";
import { getRole, listMembers } from "@/lib/admin/store";
import { isMailConfigured, sendMail } from "@/lib/mail";
import { addNotification } from "@/lib/notificationStore";

export interface OpsRecipient {
  userId: string;
  email: string;
  owner: boolean;
}

export async function opsRecipients(): Promise<OpsRecipient[]> {
  const out = new Map<string, OpsRecipient>();
  try {
    const owners = ownerEmails();
    const client = await clerkClient();
    const list = (await client.users.getUserList({ emailAddress: owners, limit: 20 })) as {
      data?: Array<{ id: string; emailAddresses?: ClerkEmailish[] }>;
    };
    for (const u of list.data ?? []) {
      const email = verifiedEmails(u.emailAddresses).find((e) => owners.includes(e));
      if (email) out.set(u.id, { userId: u.id, email, owner: true });
    }
  } catch (e) {
    console.warn("[ops-notify] owner lookup failed", e instanceof Error ? e.message : e);
  }
  for (const m of await listMembers()) {
    if (m.status !== "active" || out.has(m.userId)) continue;
    const role = await getRole(m.roleId);
    if (role?.permissions.includes("ops:read")) out.set(m.userId, { userId: m.userId, email: m.email, owner: false });
  }
  return [...out.values()];
}

export interface NotifyResult {
  recipients: number;
  emailed: number;
  inApp: number;
  emailSkipped?: string;
}

export async function notifyOps(
  msg: { title: string; body: string; url: string },
  channels: { email: boolean; inApp: boolean } = { email: true, inApp: true },
): Promise<NotifyResult> {
  const recipients = await opsRecipients();
  let emailed = 0;
  let inApp = 0;
  let emailSkipped: string | undefined;
  for (const r of channels.inApp ? recipients : []) {
    try {
      await addNotification(r.userId, { type: "updated", title: msg.title, body: msg.body, url: msg.url });
      inApp++;
    } catch (e) {
      console.warn("[ops-notify] in-app failed", r.userId, e instanceof Error ? e.message : e);
    }
  }
  if (!channels.email) {
    emailSkipped = "email_off_for_rule";
  } else if (!isMailConfigured()) {
    emailSkipped = "mail_not_configured";
  } else if (recipients.length) {
    const site = process.env.NEXT_PUBLIC_SITE_URL || "https://www.neoconference.app";
    const res = await sendMail({
      to: recipients[0].email,
      bcc: recipients.slice(1).map((r) => r.email),
      subject: msg.title,
      text: `${msg.body}\n\n${site}${msg.url}\n\nYou receive this because you are the platform owner or an administrator with ops:read.`,
    });
    if (res.ok) emailed = recipients.length;
    else emailSkipped = res.error;
  }
  return { recipients: recipients.length, emailed, inApp, ...(emailSkipped ? { emailSkipped } : {}) };
}
