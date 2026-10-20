import "server-only";

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
    body: "The sidebar is your map. Overview shows your whole system at a glance. AI Employees lists your six AI employees — click one to chat or configure it. Leads, Appointments, Sales Pipeline and Customer Retention cover each stage of your customer journey. Approvals is where you confirm anything your AI team wants to do. On mobile, open the menu with the button at the top left.",
    links: [{ label: "Overview", href: "/overview" }, { label: "AI Employees", href: "/employees" }],
  },
  {
    id: "ai-employees",
    title: "Your six AI employees",
    keywords: ["employee", "employees", "workforce", "agent", "agents", "team", "operations", "lead hunter", "appointment setter", "sales assistant", "crm manager", "analyst", "roles"],
    body: "Your AI workforce has six roles: Operations Manager (coordination and summaries), Lead Hunter (researching potential customers), Appointment Setter (bookings using real availability), Sales Assistant (follow-ups and proposals), CRM Manager (organised records) and Performance Analyst (results and improvements). Each one is configured around your business and has its own conversations.",
    links: [{ label: "AI Employees", href: "/employees" }],
  },
  {
    id: "agent-status",
    title: "What does 'Setup required' or 'Offline' mean?",
    keywords: ["status", "setup required", "offline", "online", "busy", "unavailable", "not working", "disabled", "being set up", "provisioning", "ready", "connected"],
    body: "Online means the employee passed a live connection check and can chat. Setup required means iAcquire is still preparing its dedicated, private AI environment — you'll get a notification when it's ready. Offline means the last connection check failed; try again shortly or contact us if it persists. We never show an employee as online unless the check really succeeded.",
    links: [{ label: "AI Employees", href: "/employees" }, { label: "Contact support", href: "/support" }],
  },
  {
    id: "chatting",
    title: "Chatting with an AI employee",
    keywords: ["chat", "message", "conversation", "ask", "talk", "history", "new chat", "regenerate", "stop", "copy", "search conversations"],
    body: "Open an employee and type your question. Press Enter to send and Shift+Enter for a new line. You can stop a response, copy it, or ask for a new answer. Every employee keeps its own conversation history, which only you can see. Use the search box in the sidebar to find older conversations, and the menu on a conversation to rename or delete it.",
    links: [{ label: "AI Employees", href: "/employees" }],
  },
  {
    id: "configure-employee",
    title: "Changing how an employee works",
    keywords: ["configure", "settings", "tone", "friendly", "professional", "reply length", "concise", "detailed", "language", "personality", "customize", "change", "instructions"],
    body: "Open an employee and choose Configure. You can change its name, tone, reply length, language, responsibilities and escalation contact with simple controls, or describe a change in plain words like 'make it friendlier and less pushy'. Each change creates a new version you can roll back. Safety rules and tool permissions are managed by iAcquire and can't be changed from here.",
    links: [{ label: "AI Employees", href: "/employees" }],
  },
  {
    id: "knowledge-center",
    title: "Teaching your AI team about your business",
    keywords: ["knowledge", "faq", "prices", "pricing", "hours", "policies", "documents", "upload", "brand voice", "information", "train", "teach"],
    body: "The Knowledge Center holds your business description, services, FAQs, approved prices, hours, policies and brand voice. Your AI employees use the latest saved version from their next message. You can also upload reference documents (PDF, Word, text or CSV up to 10 MB); text files are read directly, other formats are stored securely for your team.",
    links: [{ label: "Knowledge Center", href: "/knowledge" }],
  },
  {
    id: "onboarding",
    title: "Company setup and onboarding",
    keywords: ["onboarding", "setup", "set up", "wizard", "company profile", "get started", "start", "goals", "questions"],
    body: "The setup wizard asks a few short questions about your business, goals and communication style, then prepares a configuration for each AI employee. It saves as you go, so you can leave and come back. You can update everything later in Settings and the Knowledge Center.",
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
    body: "Set your targeting rules in Leads, then ask your Lead Hunter to research. Results appear in a review queue with sources, a score and an explanation. Research only means a business may fit — it doesn't mean they're interested or that they've agreed to be contacted. Approve leads before anything is sent to your CRM; outreach always needs separate approval.",
    links: [{ label: "Leads", href: "/leads" }],
  },
  {
    id: "appointments",
    title: "Appointments and calendars",
    keywords: ["appointment", "appointments", "calendar", "booking", "book", "meeting", "reschedule", "cancel", "availability", "google meet", "timezone"],
    body: "Appointments shows meetings from your connected GoHighLevel calendar, in your workspace timezone. Your iAcquire team connects the calendar for you. Booking, rescheduling and cancelling through AI always go through approval, and we only show meeting links and confirmations that your calendar actually returned.",
    links: [{ label: "Appointments", href: "/appointments" }],
  },
  {
    id: "sales",
    title: "Sales pipeline and opportunities",
    keywords: ["sales", "pipeline", "opportunity", "opportunities", "deal", "deals", "stage", "won", "lost", "proposal", "follow-up", "notes"],
    body: "Sales Pipeline shows your opportunities by stage from your connected CRM. Click any card for details, notes and related AI activity. Changes to deals or stages proposed by AI employees go to Approvals first. If your CRM isn't connected yet, the page shows its connection status instead of sample numbers.",
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
    body: "Analytics uses only real data from your workspace and connected tools. Each metric has a definition, and anything we can't measure yet is clearly marked as unavailable rather than estimated. Use the date range filter at the top, and the 'Ask Performance Analyst' buttons to get an explanation of a section.",
    links: [{ label: "Analytics", href: "/analytics" }],
  },
  {
    id: "approvals",
    title: "How approvals work",
    keywords: ["approval", "approvals", "approve", "reject", "request changes", "risk", "pending", "expired", "permission to act"],
    body: "Whenever an AI employee wants to do something that affects your business — importing leads, sending a message, updating your CRM or changing its configuration — it appears in Approvals with the reason, expected effect and risk level. Owners and admins can approve, reject or request changes; high-risk items need the owner. Rejected or expired requests never run, and each approval runs at most once.",
    links: [{ label: "Approvals", href: "/approvals" }],
  },
  {
    id: "team",
    title: "Inviting your team and roles",
    keywords: ["invite", "team", "member", "members", "user", "users", "role", "roles", "owner", "admin", "access", "remove", "revoke"],
    body: "Go to Settings → Team to invite people by email. Owners manage everything including billing; Admins manage daily operations and team access; Members can use AI employees and view business data. You can change roles or remove access at any time.",
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
    body: "The bell icon shows updates such as completed AI tasks, leads awaiting approval, support replies and connection problems. Click one to jump to the right page. Choose which alerts you want in Settings → Notifications.",
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
    body: "iAcquire is an AI automation agency. We build and run an AI-powered client acquisition and retention system: data hunt and AI lead generation, AI appointment setting, AI sales and follow-up, and customer retention — powered by a dedicated AI workforce configured around your business. We manage the infrastructure; you work from this portal. Beyond the core system, we can also build custom automations, AI agents, websites and software as optional, separately quoted projects.",
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
