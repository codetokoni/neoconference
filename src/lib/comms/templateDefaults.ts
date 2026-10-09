// src/lib/comms/templateDefaults.ts
//
// Every transactional email the platform sends, with the wording it had
// before templates existed as the default. Until an administrator edits one
// (Admin → Email templates) the default is what goes out, character for
// character — src/lib/__tests__/comms.smoke.ts holds each default against
// the code that used to build it.
//
// Pure data, safe for client components (the template editor lists these).
//
// Adding a template: add an entry here, then send with
// sendTemplateEmail("<id>", …) from src/lib/comms/templates.ts. Variables are
// filled as {{name}}; {{#name}}…{{/name}} shows when set, {{^name}}…{{/name}}
// when not. `sample` values drive the editor's preview and the test send.

export interface TemplateVariable {
  name: string;
  description: string;
  sample: string | number | boolean;
}

export interface TemplateParts {
  subject: string;
  /** Empty = the email is sent as plain text only. */
  html: string;
  text: string;
  /** One line for the bell and push, where a template also feeds those. */
  short?: string;
}

export interface TemplateDef {
  id: string;
  name: string;
  group: string;
  description: string;
  /** Who it goes to, for the editor. */
  audience: string;
  variables: TemplateVariable[];
  defaults: TemplateParts;
}

const G_P = '<p style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">';
const G_BUTTON =
  '<p style="font-family:system-ui,sans-serif"><a href="{{link}}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#06b6d4;color:#020617;text-decoration:none;font-weight:600">Open the meeting</a></p>';
const G_DESC =
  '{{#description}}<p style="font-family:system-ui,sans-serif;font-size:14px;color:#334155;white-space:pre-line">{{description}}</p>{{/description}}';

const GROUP_VARS: TemplateVariable[] = [
  { name: "senderName", description: "Who caused the notice", sample: "Ada Obi" },
  { name: "title", description: "The meeting's name", sample: "Weekly prayer meeting" },
  { name: "when", description: "Date, time and timezone of the (first) meeting", sample: "Mon 12 Oct 2026, 10:00 (Africa/Lagos)" },
  { name: "many", description: 'Either " — <when>" or " (N meetings from <when>)" for a series', sample: " — Mon 12 Oct 2026, 10:00 (Africa/Lagos)" },
  { name: "count", description: "How many meetings the notice covers", sample: 1 },
  { name: "series", description: "Set when the notice covers more than one meeting", sample: false },
  { name: "link", description: "The meeting's page", sample: "https://www.neoconference.app/weekly-prayer" },
  { name: "description", description: "The meeting's description, if it has one", sample: "Bring your notes from last week." },
];

function groupTemplate(kind: string, name: string, subject: string, line: string, button: boolean): TemplateDef {
  return {
    id: `group.${kind}`,
    name,
    group: "Group meetings",
    description: `Sent to a group's members when a meeting is ${kind === "added" ? "joined by someone new" : kind}. Scheduled, changed and cancelled notices carry a calendar file.`,
    audience: "Group members",
    variables: GROUP_VARS,
    defaults: {
      subject,
      html: `${G_P}${line}</p>${button ? G_BUTTON : ""}${G_DESC}`,
      text: button ? `${line}\n\n{{link}}` : line,
    },
  };
}

const S_P = '<p style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a;white-space:pre-line">';
const S_BUTTON =
  '<p style="font-family:system-ui,sans-serif"><a href="{{ticketUrl}}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#06b6d4;color:#020617;text-decoration:none;font-weight:600">{{#signedIn}}Open your ticket{{/signedIn}}{{^signedIn}}Sign in to follow it{{/signedIn}}</a></p>';
const S_FOOT = '<p style="font-family:system-ui,sans-serif;font-size:12px;color:#64748b">NeoConference support · Replies to this email are not read; answer on the website.</p>';
const SUPPORT_VARS: TemplateVariable[] = [
  { name: "number", description: "The ticket number", sample: 1042 },
  { name: "subject", description: "The ticket's subject", sample: "Recording did not start" },
  { name: "ticketUrl", description: "The ticket's page", sample: "https://www.neoconference.app/support/tickets/t_abc123" },
  { name: "signedIn", description: "Set when the ticket belongs to an account (not sent signed out)", sample: true },
  { name: "email", description: "The address the ticket came from", sample: "ada@example.com" },
];
const BILLING_VARS: TemplateVariable[] = [
  { name: "plan", description: 'The plan\'s name, capitalised ("your" when unknown)', sample: "Pro" },
  { name: "amount", description: "The price with its currency, or empty when unknown", sample: "25.00 USD" },
  { name: "currency", description: "The currency code", sample: "USD" },
  { name: "cycle", description: '"monthly" or "annual"', sample: "monthly" },
  { name: "endDate", description: "When the plan runs out (renewal reminders only)", sample: "Fri, 16 Oct 2026" },
  { name: "pricingUrl", description: "The pricing page", sample: "https://www.neoconference.app/pricing" },
  { name: "billingUrl", description: "Their billing history", sample: "https://www.neoconference.app/dashboard/billing" },
];
const B_PRICE = "{{#amount}} ({{amount}}, {{cycle}}){{/amount}}";
const B_SIGN = "— NeoConference";

/** Each paragraph is plain text; the HTML version links its {{…Url}}s. */
function billingTemplate(kind: string, name: string, description: string, subject: string, paras: string[]): TemplateDef {
  return {
    id: `billing.${kind}`,
    name,
    group: "Billing",
    description: `${description} Turned on, with its days, in Admin → Billing → Settings.`,
    audience: "The account holder",
    variables: BILLING_VARS,
    defaults: {
      subject,
      // The blank paragraph before the signature is how these always went out.
      text: [...paras, "", B_SIGN].join("\n\n"),
      html: paras.map((p) => `<p>${p.replace(/\{\{(\w+Url)\}\}/g, '<a href="{{$1}}">{{$1}}</a>')}</p>`).join("") + `<p>${B_SIGN}</p>`,
    },
  };
}

const S_INTRO_TEXT =
  "Thanks for getting in touch. Your request is with the NeoConference team{{#signedIn}} and you can follow it on the website.{{/signedIn}}{{^signedIn}}. We'll answer at this address. To read the conversation on the website, sign in or sign up with {{email}}.{{/signedIn}}";

export const TEMPLATE_DEFS: TemplateDef[] = [
  groupTemplate("scheduled", "Meeting invitation", "Invitation: {{title}}{{many}}", "{{senderName}} invited you to “{{title}}”{{many}}.", true),
  groupTemplate("updated", "Meeting changed", "Updated: {{title}}{{many}}", "{{senderName}} changed “{{title}}”. It is now {{when}}.", true),
  groupTemplate(
    "cancelled",
    "Meeting cancelled",
    "Cancelled: {{title}}{{many}}",
    "{{senderName}} cancelled {{#series}}{{count}} meetings of “{{title}}”, from {{when}}.{{/series}}{{^series}}“{{title}}” ({{when}}).{{/series}}",
    false,
  ),
  groupTemplate("started", "Meeting started", "{{senderName}} started {{title}} — join now", "{{senderName}} started “{{title}}”. Join now.", true),
  groupTemplate("added", "Added to a meeting", "{{senderName}} added you to {{title}}", "{{senderName}} added you to “{{title}}”. Join now.", true),
  {
    id: "admin.appointed",
    name: "Administrator appointed",
    group: "Administration",
    description: "Sent to someone the moment they are made a platform administrator.",
    audience: "The new administrator",
    variables: [
      { name: "appointer", description: "Who appointed them", sample: "Victor Agbasa" },
      { name: "roleName", description: "Their administrator role", sample: "Support" },
      { name: "origin", description: "The site's address", sample: "https://www.neoconference.app" },
    ],
    defaults: {
      subject: "You are now a NeoConference administrator",
      text:
        "{{appointer}} made you an administrator ({{roleName}}) on NeoConference.\n\n" +
        "Open {{origin}}/admin and set up two-factor authentication with an authenticator app to start.\n\n" +
        "If you did not expect this, reply to this email.",
      html:
        "<p>{{appointer}} made you an administrator (<b>{{roleName}}</b>) on NeoConference.</p>" +
        '<p><a href="{{origin}}/admin">Open the admin area</a> and set up two-factor authentication with an authenticator app to start.</p>' +
        "<p>If you did not expect this, reply to this email.</p>",
    },
  },
  {
    id: "support.received",
    name: "Support request received",
    group: "Support",
    description: "Sent when someone opens a support ticket (or support opens one for them and chooses to tell them).",
    audience: "Whoever the ticket is for",
    variables: SUPPORT_VARS,
    defaults: {
      subject: "[#{{number}}] We received your request: {{subject}}",
      text: `${S_INTRO_TEXT}\n\nTicket #{{number}}: {{subject}}\n\n{{ticketUrl}}`,
      // The HTML paragraph is the same sentence, with its apostrophe written escaped as it always went out.
      html: `${S_P}${S_INTRO_TEXT.replace("We'll", "We&#39;ll")}</p>${S_P}<b>Ticket #{{number}}:</b> {{subject}}</p>${S_BUTTON}${S_FOOT}`,
    },
  },
  {
    id: "support.reply",
    name: "Support replied",
    group: "Support",
    description: "Sent when support answers a ticket publicly. Accounts also get a bell notification.",
    audience: "Whoever the ticket is for",
    variables: [
      ...SUPPORT_VARS,
      { name: "agentName", description: "Who answered", sample: "Sam from support" },
      { name: "body", description: "The reply", sample: "Thanks — that is fixed now. Try again and tell us if it happens again." },
    ],
    defaults: {
      subject: "[#{{number}}] Reply from NeoConference support: {{subject}}",
      text: "{{agentName}} replied to your ticket #{{number}}:\n\n{{body}}\n\n{{ticketUrl}}",
      html: `${S_P}<b>{{agentName}}</b> replied to your ticket #{{number}}:</p>${S_P}{{body}}</p>${S_BUTTON}${S_FOOT}`,
    },
  },
  billingTemplate("failed_payment", "Payment failed", "When a plan payment failed and nothing was paid since.", "Your NeoConference {{plan}} payment did not go through", [
    `Your payment for the {{plan}} plan${B_PRICE} did not go through, so the plan was not added.`,
    "You can try again here: {{pricingUrl}}",
  ]),
  billingTemplate("abandoned_checkout", "Checkout not finished", "When someone started paying for a plan and never finished.", "Finish upgrading to NeoConference {{plan}}", [
    `You started upgrading to the {{plan}} plan${B_PRICE} but the payment was not completed.`,
    "Pick up where you left off: {{pricingUrl}}",
  ]),
  billingTemplate("renewal_reminder", "Plan ending soon", "Before a paid plan runs out. Plans do not renew by themselves.", "Your NeoConference {{plan}} plan ends on {{endDate}}", [
    `Your {{plan}} plan${B_PRICE} runs until {{endDate}}. It does not renew by itself: to keep it, buy another period before then.`,
    "Renew: {{pricingUrl}}",
    "Your billing history: {{billingUrl}}",
  ]),
  {
    id: "digest.redemptions",
    name: "Daily invite redemptions",
    group: "Digests",
    description: "Once a day, to a meeting owner set up with DIGEST_TO_<userId>: who redeemed their invites in the last 24 hours.",
    audience: "Meeting owners with a digest address",
    variables: [
      { name: "count", description: "Redemptions in the last 24 hours", sample: 3 },
      { name: "plural", description: '"s" unless the count is 1', sample: "s" },
      { name: "details", description: "Per meeting, who redeemed and when (plain text lines)", sample: "Sunday service\n  - Ada Obi (2026-10-09T09:12:00Z)\n  - Tunde (2026-10-09T09:40:00Z)" },
    ],
    defaults: {
      subject: "NeoConference — {{count}} new redemption{{plural}} today",
      html: "",
      text: "NeoConference daily digest\n\n{{count}} redemption{{plural}} in the last 24h:\n\n{{details}}",
    },
  },
  {
    id: "reminder.meetings",
    name: "Free meetings running out",
    group: "Usage reminders",
    description: "When someone on a plan with a lifetime meeting cap (Free: 5) reaches a reminder threshold (Communication → Reminders).",
    audience: "The account holder",
    variables: [
      { name: "name", description: "Their first name, or empty", sample: "Ada" },
      { name: "used", description: "Meetings created so far", sample: 4 },
      { name: "cap", description: "The plan's lifetime cap", sample: 5 },
      { name: "left", description: "Meetings left", sample: 1 },
      { name: "reached", description: "Set when none are left", sample: false },
      { name: "planName", description: "Their plan", sample: "Free" },
      { name: "origin", description: "The site's address", sample: "https://www.neoconference.app" },
    ],
    defaults: {
      subject: "{{#reached}}You've used all {{cap}} meetings on the {{planName}} plan{{/reached}}{{^reached}}You've used {{used}} of your {{cap}} meetings{{/reached}}",
      short: "{{#reached}}New meetings need a paid plan. See the plans.{{/reached}}{{^reached}}{{left}} left on the {{planName}} plan.{{/reached}}",
      text:
        "Hi{{#name}} {{name}}{{/name}},\n\n" +
        "{{#reached}}You have created all {{cap}} meetings the {{planName}} plan includes, so new meetings need a paid plan. Meetings you already created keep working.{{/reached}}" +
        "{{^reached}}You have created {{used}} of the {{cap}} meetings the {{planName}} plan includes. {{left}} left.{{/reached}}\n\n" +
        "See the plans: {{origin}}/pricing\n\n— NeoConference",
      html:
        '<p style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">Hi{{#name}} {{name}}{{/name}},</p>' +
        '<p style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">' +
        "{{#reached}}You have created all {{cap}} meetings the {{planName}} plan includes, so new meetings need a paid plan. Meetings you already created keep working.{{/reached}}" +
        "{{^reached}}You have created {{used}} of the {{cap}} meetings the {{planName}} plan includes. {{left}} left.{{/reached}}</p>" +
        '<p style="font-family:system-ui,sans-serif"><a href="{{origin}}/pricing" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#06b6d4;color:#020617;text-decoration:none;font-weight:600">See the plans</a></p>',
    },
  },
  {
    id: "reminder.recording",
    name: "Recording hours running out",
    group: "Usage reminders",
    description: "When the hours someone's meetings recorded this month reach a reminder threshold of their plan's monthly allowance.",
    audience: "The meeting owner",
    variables: [
      { name: "name", description: "Their first name, or empty", sample: "Ada" },
      { name: "usedHours", description: "Hours recorded this month", sample: "8.2" },
      { name: "capHours", description: "The plan's monthly hours", sample: 10 },
      { name: "percent", description: "Share used, rounded", sample: 82 },
      { name: "reached", description: "Set when the allowance is used up", sample: false },
      { name: "resets", description: "When the hours reset", sample: "1 November" },
      { name: "planName", description: "Their plan", sample: "Pro" },
      { name: "origin", description: "The site's address", sample: "https://www.neoconference.app" },
    ],
    defaults: {
      subject: "{{#reached}}This month's recording hours are used up{{/reached}}{{^reached}}{{percent}}% of this month's recording hours used{{/reached}}",
      short: "{{usedHours}} of {{capHours}} hours recorded. They reset on {{resets}}.",
      text:
        "Hi{{#name}} {{name}}{{/name}},\n\n" +
        "{{#reached}}Your meetings have recorded all {{capHours}} hours the {{planName}} plan includes this month. New recordings will not start until the hours reset on {{resets}}.{{/reached}}" +
        "{{^reached}}Your meetings have recorded {{usedHours}} of the {{capHours}} hours the {{planName}} plan includes this month. They reset on {{resets}}.{{/reached}}\n\n" +
        "See the plans: {{origin}}/pricing\n\n— NeoConference",
      html:
        '<p style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">Hi{{#name}} {{name}}{{/name}},</p>' +
        '<p style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">' +
        "{{#reached}}Your meetings have recorded all {{capHours}} hours the {{planName}} plan includes this month. New recordings will not start until the hours reset on {{resets}}.{{/reached}}" +
        "{{^reached}}Your meetings have recorded {{usedHours}} of the {{capHours}} hours the {{planName}} plan includes this month. They reset on {{resets}}.{{/reached}}</p>" +
        '<p style="font-family:system-ui,sans-serif"><a href="{{origin}}/pricing" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#06b6d4;color:#020617;text-decoration:none;font-weight:600">See the plans</a></p>',
    },
  },
  // Sent by automation rules (src/lib/automation/actions.ts).
  {
    id: "reminder.trial",
    name: "Trial ending",
    group: "Usage reminders",
    description: "When a trial is about to end (an automation rule's \"Trial ends in\" condition, Admin → Automation).",
    audience: "The account holder",
    variables: [
      { name: "name", description: "Their first name, or empty", sample: "Ada" },
      { name: "planName", description: "The plan they are trying", sample: "Business" },
      { name: "days", description: "Whole days left", sample: 3 },
      { name: "endsOn", description: "When the trial ends", sample: "Mon, 12 Oct 2026" },
      { name: "origin", description: "The site's address", sample: "https://www.neoconference.app" },
    ],
    defaults: {
      subject: "Your {{planName}} trial ends in {{days}} day(s)",
      short: "Your {{planName}} trial ends on {{endsOn}}. Choose a plan to keep its features.",
      text:
        "Hi{{#name}} {{name}}{{/name}},\n\n" +
        "Your {{planName}} trial ends on {{endsOn}}. After that your account goes back to the Free plan. To keep the {{planName}} features, choose a plan before then.\n\n" +
        "See the plans: {{origin}}/pricing\n\n— NeoConference",
      html:
        '<p style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">Hi{{#name}} {{name}}{{/name}},</p>' +
        '<p style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">Your {{planName}} trial ends on {{endsOn}}. After that your account goes back to the Free plan. To keep the {{planName}} features, choose a plan before then.</p>' +
        '<p style="font-family:system-ui,sans-serif"><a href="{{origin}}/pricing" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#06b6d4;color:#020617;text-decoration:none;font-weight:600">See the plans</a></p>',
    },
  },
  {
    id: "automation.report",
    name: "Scheduled report",
    group: "Automation",
    description: "A report an automation rule builds and emails on its schedule (Admin → Automation). The tables come as CSV attachments.",
    audience: "The platform owner (and ops administrators, if the rule says so)",
    variables: [
      { name: "reportName", description: "The rule's name", sample: "Weekly summary to the owner" },
      { name: "period", description: "The days covered", sample: "2026-10-02 to 2026-10-08 (UTC)" },
      { name: "summary", description: "The headline figures, one per line", sample: "Active users: 120\nMeetings: 48" },
      { name: "origin", description: "The site's address", sample: "https://www.neoconference.app" },
    ],
    defaults: {
      subject: "NeoConference: {{reportName}} ({{period}})",
      html: "",
      text: "{{reportName}}\n{{period}}\n\n{{summary}}\n\nThe tables are attached as CSV. Analytics: {{origin}}/admin/analytics\n\n— NeoConference",
    },
  },
];

export function templateDef(id: string): TemplateDef | undefined {
  return TEMPLATE_DEFS.find((t) => t.id === id);
}

/** The sample values a template's preview and test send use. */
export function sampleVars(def: TemplateDef): Record<string, string | number | boolean> {
  return Object.fromEntries(def.variables.map((v) => [v.name, v.sample]));
}
