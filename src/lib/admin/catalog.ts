// src/lib/admin/catalog.ts
//
// The platform-administration permission catalog: what an administrator may
// do across the whole platform (as opposed to src/lib/permissions.ts, which
// is per meeting and per group). Pure data — safe for client components,
// which use it to draw the role editor and hide what a role cannot reach.
// The server is what enforces it (src/lib/admin/context.ts).

export const ADMIN_PERMISSIONS = [
  { key: "overview:read", group: "Dashboard", label: "See the overview figures" },

  { key: "users:read", group: "Users", label: "Search and view users and organisations" },
  { key: "users:write", group: "Users", label: "Edit account details, verification, notes and tags" },
  { key: "users:suspend", group: "Users", label: "Suspend, reactivate and sign users out" },
  { key: "users:delete", group: "Users", label: "Delete accounts", sensitive: true },
  { key: "users:support_access", group: "Users", label: "Open a user's workspace (audited support session)", sensitive: true },

  { key: "events:read", group: "Meetings", label: "View every meeting and event" },
  { key: "events:write", group: "Meetings", label: "End, rename, delete and transfer meetings" },

  { key: "plans:read", group: "Plans & billing", label: "View plans and subscriptions" },
  { key: "plans:write", group: "Plans & billing", label: "Create, edit and archive plans, coupons and add-ons", sensitive: true },
  { key: "subscriptions:write", group: "Plans & billing", label: "Assign, extend, pause or cancel a user's subscription" },
  { key: "billing:read", group: "Plans & billing", label: "View payments, invoices and revenue" },
  { key: "billing:refund", group: "Plans & billing", label: "Issue refunds", sensitive: true },
  { key: "billing:settings", group: "Plans & billing", label: "Configure payment gateways, taxes and invoice details", sensitive: true },

  { key: "content:read", group: "Content", label: "View files, recordings and storage" },
  { key: "content:moderate", group: "Content", label: "Moderate reported content, remove and restore files" },

  { key: "analytics:read", group: "Analytics", label: "View analytics, activity and logs" },
  { key: "reports:export", group: "Analytics", label: "Export reports (CSV / Excel)" },

  { key: "settings:write", group: "Settings", label: "Branding, notices, regional and registration settings" },
  { key: "features:write", group: "Settings", label: "Turn features on or off, maintenance mode", sensitive: true },
  { key: "integrations:write", group: "Settings", label: "Integrations, API credentials and webhooks", sensitive: true },

  { key: "notifications:send", group: "Communication", label: "Send announcements and edit email templates" },

  { key: "support:read", group: "Support", label: "View support tickets and help articles" },
  { key: "support:write", group: "Support", label: "Answer, assign and close tickets; edit help articles" },

  { key: "audit:read", group: "Security", label: "Read the audit log" },
  { key: "ops:read", group: "Operations", label: "View service health, jobs and backups" },
  { key: "ops:write", group: "Operations", label: "Retry jobs, run maintenance tasks, manage incidents" },
  { key: "automation:write", group: "Operations", label: "Create, pause and edit automation rules" },

  { key: "data:export", group: "Data", label: "Export a user's data" },
  { key: "data:delete", group: "Data", label: "Bulk deletes and retention changes", sensitive: true },

  { key: "admins:read", group: "Administrators", label: "See the administrator list and roles" },
  { key: "admins:manage", group: "Administrators", label: "Appoint, edit, suspend and remove administrators", sensitive: true },
  { key: "roles:manage", group: "Administrators", label: "Create and edit administrator roles", sensitive: true },
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number]["key"];

export const ALL_ADMIN_PERMISSIONS: AdminPermission[] = ADMIN_PERMISSIONS.map((p) => p.key);

/** Actions behind these need a fresh authenticator code (step-up), not just an admin session. */
export const SENSITIVE_PERMISSIONS: ReadonlySet<AdminPermission> = new Set(
  ADMIN_PERMISSIONS.filter((p) => "sensitive" in p && p.sensitive).map((p) => p.key),
);

export function isAdminPermission(v: unknown): v is AdminPermission {
  return typeof v === "string" && (ALL_ADMIN_PERMISSIONS as string[]).includes(v);
}

export interface AdminRole {
  id: string;
  name: string;
  description: string;
  permissions: AdminPermission[];
  builtIn: boolean;
  createdAt?: number;
  updatedAt?: number;
  createdBy?: string;
}

const READ_ONLY: AdminPermission[] = [
  "overview:read",
  "users:read",
  "events:read",
  "plans:read",
  "billing:read",
  "content:read",
  "analytics:read",
  "support:read",
  "audit:read",
  "ops:read",
  "admins:read",
];

/** Roles every platform has. Not editable; custom roles cover the rest. */
export const BUILT_IN_ROLES: AdminRole[] = [
  {
    id: "super_admin",
    name: "Super admin",
    description: "Everything an administrator can do. Cannot transfer ownership or act on the owner.",
    permissions: ALL_ADMIN_PERMISSIONS,
    builtIn: true,
  },
  {
    id: "support",
    name: "Support",
    description: "Helps users: accounts, sign-outs, tickets and audited support sessions.",
    permissions: [
      "overview:read",
      "users:read",
      "users:write",
      "users:suspend",
      "users:support_access",
      "events:read",
      "plans:read",
      "support:read",
      "support:write",
      "data:export",
    ],
    builtIn: true,
  },
  {
    id: "billing",
    name: "Billing",
    description: "Plans, subscriptions, payments and refunds.",
    permissions: [
      "overview:read",
      "users:read",
      "plans:read",
      "plans:write",
      "subscriptions:write",
      "billing:read",
      "billing:refund",
      "billing:settings",
      "analytics:read",
      "reports:export",
    ],
    builtIn: true,
  },
  {
    id: "moderator",
    name: "Moderator",
    description: "Content, reports and meetings.",
    permissions: [
      "overview:read",
      "users:read",
      "users:suspend",
      "events:read",
      "events:write",
      "content:read",
      "content:moderate",
      "support:read",
    ],
    builtIn: true,
  },
  {
    id: "analyst",
    name: "Analyst (read-only)",
    description: "Sees everything, changes nothing.",
    permissions: [...READ_ONLY, "reports:export"],
    builtIn: true,
  },
];

export function builtInRole(id: string): AdminRole | undefined {
  return BUILT_IN_ROLES.find((r) => r.id === id);
}

/** Permission groups in catalog order, for drawing the role editor. */
export function permissionGroups(): { group: string; items: (typeof ADMIN_PERMISSIONS)[number][] }[] {
  const out: { group: string; items: (typeof ADMIN_PERMISSIONS)[number][] }[] = [];
  for (const p of ADMIN_PERMISSIONS) {
    let g = out.find((x) => x.group === p.group);
    if (!g) out.push((g = { group: p.group, items: [] }));
    g.items.push(p);
  }
  return out;
}
