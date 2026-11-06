import "server-only";
import { SETUP_REQUIRED_LABEL } from "@/lib/agents";

export interface HelpArticle {
  id: string;
  title: string;
  keywords: string[];
  body: string;
  links: Array<{ label: string; href: string }>;
}

// Platform help only. Never place tenant data, internal agency details or credentials here.
export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: "getting-around",
    title: "Getting around the portal",
    keywords: ["navigate", "navigation", "menu", "sidebar", "find", "where", "page", "dashboard", "overview", "home"],
    body: "The sidebar is your map. Overview shows your workspace at a glance. AI Growth Partner opens your ongoing conversation and work controls. Leads, Appointments, Sales Pipeline and Customer Retention cover each stage of your customer journey. Approvals is where you review actions that need your go-ahead. Workspaces with earlier role profiles can still find them under Previous role profiles. On mobile, open the menu with the button at the top left.",
    links: [{ label: "Overview", href: "/overview" }, { label: "AI Growth Partner", href: "/growth-partner" }],
  },
  {
    id: "ai-growth-partner",
    title: "Your AI Growth Partner",
    keywords: ["employee", "employees", "workforce", "agent", "agents", "team", "operations", "lead hunter", "appointment setter", "sales assistant", "crm manager", "analyst", "roles"],
    body: "New workspaces get one AI Growth Partner: one identity, one private runtime, one permanent conversation and one Business Brain, with capabilities for operations, lead research, appointments, sales, CRM and performance. Your partner shares the business context across those capabilities. Workspaces created with earlier role profiles keep their history and can still open those profiles under Previous role profiles.",
    links: [{ label: "AI Growth Partner", href: "/growth-partner" }, { label: "Previous role profiles", href: "/employees" }],
  },
  {
    id: "agent-status",
    title: `What does '${SETUP_REQUIRED_LABEL}' or 'Offline' mean?`,
    keywords: ["status", "setup required", "offline", "online", "busy", "unavailable", "not working", "disabled", "being set up", "provisioning", "ready", "connected"],
    body: `Online means your Growth Partner passed a live connection check and can chat. ${SETUP_REQUIRED_LABEL} means either that your setup payment has not been confirmed yet or that iAcquire is still preparing the dedicated, private runtime. The Growth Partner page shows the current setup state. You'll get a notification when it is ready. Offline means the last connection check failed; contact support if it persists. We never show the Growth Partner as online unless the check really succeeded.`,
    links: [{ label: "AI Growth Partner", href: "/growth-partner" }, { label: "Contact support", href: "/support" }],
  },
  {
    id: "chatting",
    title: "Chatting with your AI Growth Partner",
    keywords: ["chat", "message", "conversation", "ask", "talk", "history", "new chat", "regenerate", "stop", "copy", "search conversations"],
    body: "Open AI Growth Partner and type your question in the permanent conversation. Your partner uses the shared Business Brain and can help across its capabilities. Review requests for important changes appear in Approvals. Previous role profiles retain their original separate conversation histories.",
    links: [{ label: "AI Growth Partner", href: "/growth-partner" }],
  },
  {
    id: "configure-employee",
    title: "Changing how your AI Growth Partner works",
    keywords: ["configure", "settings", "tone", "friendly", "professional", "reply length", "concise", "detailed", "language", "personality", "customize", "change", "instructions"],
    body: "Use the Business Brain to review the approved facts and preferences your Growth Partner shares across its work. You can also ask in the permanent conversation to update supported settings, such as targeting or schedules; the partner confirms the saved change. Sensitive actions still follow approvals, and tool permissions are managed by iAcquire.",
    links: [{ label: "Business Brain", href: "/growth-partner" }, { label: "AI Growth Partner", href: "/growth-partner" }],
  },
  {
    id: "knowledge-center",
    title: "Your Business Brain",
    keywords: ["knowledge", "faq", "prices", "pricing", "hours", "policies", "documents", "upload", "brand voice", "information", "train", "teach"],
    body: "Your Business Brain keeps the approved business context your AI Growth Partner uses across its capabilities. Review suggested or missing details before confirming them. The Knowledge Center remains available for workspaces using earlier employee profiles.",
    links: [{ label: "Business Brain", href: "/growth-partner" }, { label: "Knowledge Center", href: "/knowledge" }],
  },
  {
    id: "onboarding",
    title: "Company setup and onboarding",
    keywords: ["onboarding", "setup", "set up", "wizard", "company profile", "get started", "start", "goals", "questions"],
    body: "The setup wizard asks about your business, goals and communication style, then builds the first Business Brain for your AI Growth Partner. It saves as you go, so you can leave and come back. Review suggested details before approving the setup.",
    links: [{ label: "Company setup", href: "/onboarding" }, { label: "Business profile", href: "/settings" }],
  },
  {
    id: "setup-center",
    title: "Track your setup and complete your next steps",
    keywords: ["setup center", "setup progress", "milestone", "blocked", "waiting for client", "needs you", "website review", "domain verification", "calendar connection", "activation", "final review"],
    body: "Open Setup Center to see the work iAcquire is doing and the few things we need from you. An owner or admin can answer requests, share missing information, approve a website preview or ask for changes. A response goes to our team for review; it never claims a calendar, email or website is connected. Connecting Google Calendar requires the real Google authorization flow, and email or domain checks require verified provider or domain state. The task percentage measures completed setup work; final activation additionally needs successful connection checks and an agency review. Your team handles the technical configuration. If a step is blocked or unclear, use Talk to iAcquire Team or Support.",
    links: [{ label: "Setup Center", href: "/setup" }, { label: "Talk to the team", href: "/support" }],
  },
  {
    id: "leads",
    title: "Lead research and the review queue",
    keywords: ["lead", "leads", "research", "prospect", "targeting", "find businesses", "data hunt", "score", "qualify", "qualification", "influencer", "export"],
    body: "Set your targeting rules in Leads, then ask your AI Growth Partner to research prospects. Results appear in a review queue with sources, a score and an explanation. Research only means a business may fit — it doesn't mean they're interested or that they've agreed to be contacted. Review prospects before adding them to your CRM; outreach always needs separate approval.",
    links: [{ label: "Leads", href: "/leads" }],
  },
  {
    id: "appointments",
    title: "Appointments and calendars",
    keywords: ["appointment", "appointments", "calendar", "booking", "book", "meeting", "reschedule", "cancel", "availability", "google meet", "timezone"],
    body: "Appointments shows meetings from your connected GoHighLevel calendar, in your workspace timezone. Your iAcquire team connects the calendar for you. Booking, rescheduling and cancelling through AI follow your saved rules and approval settings. We only show meeting links and confirmations that your calendar actually returned.",
    links: [{ label: "Appointments", href: "/appointments" }],
  },
  {
    id: "sales",
    title: "Sales pipeline and opportunities",
    keywords: ["sales", "pipeline", "opportunity", "opportunities", "deal", "deals", "stage", "won", "lost", "proposal", "follow-up", "notes"],
    body: "Sales Pipeline shows your opportunities by stage from your connected CRM. Click any card for details, notes and related AI activity. Changes to deals or stages that need approval go to Approvals first. If your CRM isn't connected yet, the page shows its connection status instead of sample numbers.",
    links: [{ label: "Sales Pipeline", href: "/sales" }],
  },
  {
    id: "retention",
    title: "Customer retention",
    keywords: ["retention", "customers", "renewal", "feedback", "health", "churn", "repeat business", "service history", "onboarding progress"],
    body: "Customer Retention tracks your active customers, onboarding progress, follow-ups, open issues, feedback and renewal dates. You can add customers manually today; CRM-based retention automation is connected by the iAcquire team when you're ready.",
    links: [{ label: "Customer Retention", href: "/retention" }],
  },
  {
    id: "analytics",
    title: "Reading your analytics",
    keywords: ["analytics", "report", "reports", "metrics", "conversion", "funnel", "performance", "chart", "date range", "export csv", "kpi"],
    body: "Analytics uses only real data from your workspace and connected tools. Each metric has a definition, and anything we can't measure yet is clearly marked as unavailable rather than estimated. Use the date range filter at the top, and ask your AI Growth Partner to explain a section.",
    links: [{ label: "Analytics", href: "/analytics" }],
  },
  {
    id: "approvals",
    title: "How approvals work",
    keywords: ["approval", "approvals", "approve", "reject", "request changes", "risk", "pending", "expired", "permission to act"],
    body: "When an action needs your approval — such as contacting customers, importing prospects or making a sensitive CRM change — it appears in Approvals with the reason, expected effect and risk level. Owners and admins can approve, reject or request changes; high-risk items need the owner. Rejected or expired requests never run, and each approval runs at most once.",
    links: [{ label: "Approvals", href: "/approvals" }],
  },
  {
    id: "team",
    title: "Inviting your team and roles",
    keywords: ["invite", "team", "member", "members", "user", "users", "role", "roles", "owner", "admin", "access", "remove", "revoke"],
    body: "Go to Settings → Team to invite people by email. Owners manage everything including billing; Admins manage daily operations and team access; Members can use the AI Growth Partner and view business data. You can change roles or remove access at any time.",
    links: [{ label: "Team settings", href: "/settings/team" }],
  },
  {
    id: "integrations",
    title: "Connecting your CRM and tools",
    keywords: ["integration", "integrations", "connect", "gohighlevel", "ghl", "crm", "slack", "n8n", "calendar connection", "api key", "connected"],
    body: "Settings → Integrations shows the real connection status of your CRM, calendar and other tools. iAcquire connects and manages these securely for you, so you never need to paste API keys. If something shows as not connected, use Request connection and our team will set it up.",
    links: [{ label: "Integrations", href: "/settings/integrations" }],
  },
  {
    id: "notifications",
    title: "Notifications",
    keywords: ["notification", "notifications", "alerts", "bell", "unread", "email alerts"],
    body: "The bell icon shows updates such as completed AI work, prospects awaiting approval, support replies and connection problems. Click one to jump to the right page. Choose which alerts you want in Settings → Notifications.",
    links: [{ label: "Notification settings", href: "/settings/notifications" }],
  },
  {
    id: "security",
    title: "Password, sign-in and security",
    keywords: ["password", "reset", "forgot", "login", "log in", "sign in", "locked", "session", "sessions", "security", "logout", "sign out", "2fa"],
    body: "Change your password in Settings → Security, where you can also see and sign out other active sessions. If you forgot your password, use 'Forgot password' on the sign-in page. After several failed attempts, sign-in pauses for a few minutes to protect your account.",
    links: [{ label: "Security settings", href: "/settings/security" }],
  },
  {
    id: "usage",
    title: "Usage and limits",
    keywords: ["usage", "limit", "limits", "quota", "messages", "consumption", "how many", "fair use"],
    body: "Settings → Usage shows how many AI messages and research requests your workspace has used this month against its limits. You'll get a notification as you approach a limit. If you need more capacity, contact the iAcquire team.",
    links: [{ label: "Usage", href: "/settings/usage" }],
  },
  {
    id: "billing",
    title: "Billing and your iAcquire plan",
    keywords: ["billing", "price", "cost", "pay", "payment", "invoice", "receipt", "subscription", "plan", "fee", "1499", "monthly"],
    body: "iAcquire's core offer is a one-time setup fee of $1,499 for your AI-powered client acquisition and retention system — there is no required monthly subscription. Billing in the portal shows your setup payment status, activation status, and any invoices or receipts your iAcquire team has shared. There is no automatic charging in the portal. Optional extras, such as managed maintenance and custom projects, are separate, always optional, and described under Custom Projects & Add-ons. Usage is subject to the operating limits and fair-use terms in your agreement — ask us about anything specific.",
    links: [{ label: "Billing", href: "/settings/billing" }, { label: "Custom Projects & Add-ons", href: "/add-ons" }],
  },
  {
    id: "support",
    title: "Getting help from the iAcquire team",
    keywords: ["support", "help", "human", "person", "contact", "ticket", "request", "talk to", "team", "agent", "someone", "call", "email"],
    body: "Choose 'Talk to iAcquire Team' in this help panel or open Support from the sidebar. Describe what you need and we'll create a request with a reference number. You can follow its status and reply to our team at any time from the Support page.",
    links: [{ label: "Support requests", href: "/support" }],
  },
  {
    id: "services",
    title: "What iAcquire does",
    keywords: ["iacquire", "what is", "about", "service", "services", "offer", "acquisition", "automation", "hermes", "agency"],
    body: "iAcquire is an AI automation agency. We build and run an AI-powered client acquisition and retention system: prospect research, appointment support, sales follow-up and customer retention — coordinated through one AI Growth Partner configured around your business. We manage the infrastructure; you work from this portal. Beyond the core system, we can also build custom automations, websites and software as optional, separately quoted projects.",
    links: [{ label: "Overview", href: "/overview" }],
  },
  {
    id: "troubleshooting-data",
    title: "Why is a page empty or showing 'Not connected'?",
    keywords: ["empty", "no data", "not connected", "missing", "blank", "zero", "unavailable", "why", "nothing", "numbers"],
    body: "We only show real numbers. A page is empty when there's no activity yet, and shows 'Not connected' when the tool it relies on (like your CRM or calendar) hasn't been connected. Check Settings → Integrations for status, or ask us to connect it.",
    links: [{ label: "Integrations", href: "/settings/integrations" }, { label: "Support", href: "/support" }],
  },
  {
    id: "troubleshooting-invite",
    title: "Invitation or access problems",
    keywords: ["invitation", "invite expired", "can't log in", "cannot access", "access denied", "no workspace", "verify email", "verification"],
    body: "Invitations expire after 7 days — ask a workspace owner or your iAcquire contact to send a new one. If you see 'access denied', your role may not include that page; an owner can change roles in Settings → Team. If you haven't verified your email, use the link we sent or request a new one from the sign-in page.",
    links: [{ label: "Team settings", href: "/settings/team" }],
  },
];
