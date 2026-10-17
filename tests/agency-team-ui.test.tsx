// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InviteStaff } from "@/components/admin/invite-staff";
import { AgencyTeamMemberDetails } from "@/components/admin/agency-team-member-details";
import { TeamManagement } from "@/components/admin/team-management";
import type { AgencyTeamView } from "@/server/admin/team";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  inviteStaffAction: vi.fn(),
  assignStaffAction: vi.fn(),
  copyPermissionsAction: vi.fn(),
  updateMemberAction: vi.fn(),
  revokeInvitationAction: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh, back: vi.fn() }),
  usePathname: () => "/admin/team/staff-1",
}));

vi.mock("next/link", async () => {
  const React = await import("react");
  type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    onNavigate?: (event: { preventDefault: () => void; readonly defaultPrevented: boolean }) => void;
  };
  const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(function Link({ href, onNavigate, onClick, ...props }, ref) {
    return <a {...props} href={href} ref={ref} onClick={(event) => {
      onNavigate?.({ preventDefault: () => event.preventDefault(), get defaultPrevented() { return event.defaultPrevented; } });
      onClick?.(event);
    }} />;
  });
  return { default: Link };
});

vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/app/(admin)/admin/actions", () => ({
  inviteStaffAction: mocks.inviteStaffAction,
  assignStaffAction: mocks.assignStaffAction,
  copyAgencyUserPermissionsAction: mocks.copyPermissionsAction,
  updateAgencyTeamMemberAction: mocks.updateMemberAction,
  revokeInvitationAction: mocks.revokeInvitationAction,
}));

vi.mock("motion/react", async () => {
  const React = await import("react");
  type MotionDivProps = React.HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown; transition?: unknown };
  const Div = React.forwardRef<HTMLDivElement, MotionDivProps>(function Div({ initial: _initial, animate: _animate, transition: _transition, ...props }, ref) {
    return <div {...props} ref={ref} />;
  });
  return { motion: { div: Div } };
});

vi.mock("@/components/ui/button", async () => {
  const React = await import("react");
  type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; variant?: string; size?: string };
  const Button = React.forwardRef<HTMLButtonElement, Props>(function Button({ loading: _loading, variant: _variant, size: _size, ...props }, ref) {
    return <button {...props} ref={ref} />;
  });
  return { Button };
});

vi.mock("@/components/ui/overlays", async () => {
  const React = await import("react");
  type DialogProps = {
    open: boolean;
    title: React.ReactNode;
    description?: React.ReactNode;
    children?: React.ReactNode;
    footer?: React.ReactNode;
  };
  function Dialog({ open, title, description, children, footer }: DialogProps) {
    if (!open) return null;
    return <section role="dialog" aria-label={typeof title === "string" ? title : undefined}>
      <h2>{title}</h2>{description && <p>{description}</p>}{children}<footer>{footer}</footer>
    </section>;
  }
  function Switch({ checked, onCheckedChange, "aria-label": label }: { checked: boolean; onCheckedChange: (checked: boolean) => void; "aria-label": string }) {
    return <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onCheckedChange(!checked)} />;
  }
  return { Dialog, Switch };
});

vi.mock("@/components/ui/primitives", async () => {
  const React = await import("react");
  type FieldProps = { label: string; htmlFor?: string; children: React.ReactNode };
  const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(props, ref) {
    return <input {...props} ref={ref} />;
  });
  const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(props, ref) {
    return <select {...props} ref={ref} />;
  });
  function Card({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div {...props}>{children}</div>; }
  function Badge({ children }: React.HTMLAttributes<HTMLSpanElement>) { return <span>{children}</span>; }
  function Field({ label, htmlFor, children }: FieldProps) { return <label htmlFor={htmlFor}><span>{label}</span>{children}</label>; }
  function ProgressBar({ label, value }: { label: string; value: number }) { return <progress aria-label={label} value={value} max={100} />; }
  return { Card, Badge, Field, Input, Select, ProgressBar };
});

vi.mock("@/components/ui/status", async () => {
  const React = await import("react");
  function AvatarTile({ name }: { name: string }) { return <span aria-hidden="true">{name.slice(0, 1)}</span>; }
  function InfoChip({ children }: { children: React.ReactNode }) { return <span>{children}</span>; }
  function StatusPill({ children }: { children: React.ReactNode }) { return <span>{children}</span>; }
  return { AvatarTile, InfoChip, StatusPill };
});

vi.mock("@/components/ui/workspace", async () => {
  const React = await import("react");
  function PageHero({ children }: { children: React.ReactNode }) { return <section>{children}</section>; }
  return { PageHero };
});

const roleDefaults: AgencyTeamView["permissionDefaults"] = {
  agency_manager: { "crm.view": true, "website.publish": false, "projects.view": true, "projects.manage": true, "website.view": true, "website.edit": true },
  agency_staff: { "crm.view": false, "website.publish": false, "projects.view": true, "projects.manage": true, "website.view": true, "website.edit": true },
};

function makeMember(input: Partial<AgencyTeamView["members"][number]> & Pick<AgencyTeamView["members"][number], "id" | "name" | "email" | "role">): AgencyTeamView["members"][number] {
  return {
    status: "active",
    scopeMode: input.role === "agency_manager" ? "all_clients" : "assigned_clients",
    lastLoginAt: null,
    clients: [],
    permissionOverrides: {},
    revision: "3",
    activity: [],
    openTasks: 0,
    openTickets: 0,
    ...input,
  };
}

const staff = makeMember({ id: "staff-1", name: "Staff One", email: "staff@example.test", role: "agency_staff" });
const manager = makeMember({ id: "manager-1", name: "Manager One", email: "manager@example.test", role: "agency_manager" });

function makeView(): AgencyTeamView {
  return {
    permissionDefaults: roleDefaults,
    members: [
      makeMember({ ...staff, permissionOverrides: { ...staff.permissionOverrides }, clients: [...staff.clients], activity: [...staff.activity] }),
      makeMember({ ...manager, permissionOverrides: { ...manager.permissionOverrides }, clients: [...manager.clients], activity: [...manager.activity] }),
    ],
    invitations: [],
    clients: [{ id: "client-1", name: "Client Alpha", assignedStaff: 0 }],
    coverage: { total: 1, assigned: 0 },
  };
}

function renderDetails(data = makeView()) {
  return render(<AgencyTeamMemberDetails data={data} memberId="staff-1" timeZone="UTC" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inviteStaffAction.mockResolvedValue({ ok: true, data: { link: "https://www.iacquire.online/invite/one-time", delivery: { status: "captured", error: null } } });
  mocks.assignStaffAction.mockResolvedValue({ ok: true });
  mocks.copyPermissionsAction.mockResolvedValue({ ok: true });
  mocks.updateMemberAction.mockResolvedValue({ ok: true });
});

afterEach(() => cleanup());

describe("agency team administration UI", () => {
  it("keeps the standard invite on role defaults until the owner explicitly customizes and submits", async () => {
    render(<InviteStaff clients={[{ id: "client-1", name: "Client Alpha" }]} roleDefaults={roleDefaults} />);
    fireEvent.click(screen.getByRole("button", { name: "Invite teammate" }));
    fireEvent.change(screen.getByLabelText("Work email"), { target: { value: "new.staff@example.test" } });
    fireEvent.click(screen.getByLabelText("Client Alpha"));

    expect(screen.getByText("Using Agency Staff default permissions")).toBeTruthy();
    expect(mocks.inviteStaffAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Customize permissions (optional)" }));
    expect(screen.getByRole("dialog", { name: "Customize invitation permissions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Open Native CRM for invitation" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(screen.getByText("Preview permission changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save & return to invitation" }));
    expect(screen.getByText("Custom permissions configured · 1")).toBeTruthy();
    expect((screen.getByLabelText("Work email") as HTMLInputElement).value).toBe("new.staff@example.test");
    expect((screen.getByLabelText("Client Alpha") as HTMLInputElement).checked).toBe(true);
    expect(mocks.inviteStaffAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    await waitFor(() => expect(mocks.inviteStaffAction).toHaveBeenCalledWith(
      "new.staff@example.test",
      "agency_staff",
      "assigned_clients",
      ["client-1"],
      { "crm.view": "allow" },
    ));
    expect(await screen.findByText(/development mailbox/)).toBeTruthy();
  });

  it("links directory members to their dedicated detail pages and keeps Super Admin read-only", () => {
    const view = makeView();
    view.members.push(makeMember({ id: "owner-1", name: "Admin Owner", email: "owner@example.test", role: "agency_super_admin", scopeMode: "all_clients" }));
    const { container } = render(<TeamManagement data={view} timeZone="UTC" />);

    expect(container.querySelector('a[href="/admin/team/staff-1"]')).toBeTruthy();
    expect(container.querySelector('a[href="/admin/team/manager-1"]')).toBeTruthy();
    expect(container.querySelector('a[href="/admin/team/owner-1"]')).toBeNull();
  });

  it("cancels an invite permission draft without losing invite fields or persisting the draft", () => {
    render(<InviteStaff clients={[{ id: "client-1", name: "Client Alpha" }]} roleDefaults={roleDefaults} />);
    fireEvent.click(screen.getByRole("button", { name: "Invite teammate" }));
    fireEvent.change(screen.getByLabelText("Work email"), { target: { value: "keep.me@example.test" } });
    fireEvent.click(screen.getByLabelText("Client Alpha"));
    fireEvent.click(screen.getByRole("button", { name: "Customize permissions (optional)" }));
    fireEvent.click(screen.getByRole("switch", { name: "Open Native CRM for invitation" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel customization" }));

    expect((screen.getByLabelText("Work email") as HTMLInputElement).value).toBe("keep.me@example.test");
    expect((screen.getByLabelText("Client Alpha") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(/Custom permissions configured/)).toBeNull();
    expect(mocks.inviteStaffAction).not.toHaveBeenCalled();
  });

  it("requires an explicit reset before switching roles after customizing an invitation", () => {
    render(<InviteStaff clients={[]} roleDefaults={roleDefaults} />);
    fireEvent.click(screen.getByRole("button", { name: "Invite teammate" }));
    fireEvent.click(screen.getByRole("button", { name: "Customize permissions (optional)" }));
    fireEvent.click(screen.getByRole("switch", { name: "Open Native CRM for invitation" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & return to invitation" }));

    fireEvent.click(screen.getByRole("radio", { name: /Agency Manager/ }));
    expect(screen.getByText("Change role defaults?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset permissions and change role" }));
    expect(screen.getByText("Using Agency Manager default permissions")).toBeTruthy();
    expect(screen.queryByText(/Custom permissions configured/)).toBeNull();
    expect((screen.getByRole("radio", { name: /All current and future clients/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("previews permission changes, requires confirmation for a sensitive grant, then saves", async () => {
    renderDetails();
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));
    fireEvent.click(screen.getByText("Native CRM").closest("summary")!);
    fireEvent.change(screen.getByRole("combobox", { name: "Open Native CRM access" }), { target: { value: "allow" } });
    fireEvent.click(screen.getByText("Website Studio", { selector: "summary span" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Publish client websites access" }), { target: { value: "allow" } });

    expect(screen.getByText("Preview unsaved access changes")).toBeTruthy();
    expect(screen.getByText("2 unsaved role, status, scope or permission changes.")).toBeTruthy();
    expect(screen.getAllByText("Open Native CRM").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("dialog", { name: "Confirm high impact access changes" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Confirm high impact access changes" }).textContent).toContain("Publish client websites");
    expect(mocks.updateMemberAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save reviewed changes" }));
    await waitFor(() => expect(mocks.updateMemberAction).toHaveBeenCalledWith(expect.objectContaining({
      userId: "staff-1",
      permissionOverrides: { "crm.view": "allow", "website.publish": "allow" },
      expectedRevision: "3",
    })));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("shows live effective access counts and opens the matching filtered permissions", () => {
    renderDetails();
    const allowedSummary = screen.getByRole("button", { name: "2 Allowed action areas; open allowed permissions" });
    expect(allowedSummary.textContent).toContain("Allowed action areas");

    fireEvent.click(allowedSummary);
    expect(screen.getByRole("tab", { name: "Permissions" }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByRole("combobox", { name: "Filter permission state" }) as HTMLSelectElement).value).toBe("allowed");
    expect(screen.getByRole("combobox", { name: "Edit client websites access" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Open Native CRM access" })).toBeNull();
  });

  it("filters by allowed, restricted and customized states and expands and collapses permission groups", () => {
    const view = makeView();
    view.members[0].permissionOverrides = { "crm.view": "allow", "website.edit": "deny" };
    const { container } = renderDetails(view);
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));

    const groups = () => [...container.querySelectorAll<HTMLDetailsElement>("details")];
    expect(groups().length).toBeGreaterThan(1);
    expect(groups().every((group) => !group.open)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(groups().every((group) => group.open)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(groups().every((group) => !group.open)).toBe(true);

    const filter = screen.getByRole("combobox", { name: "Filter permission state" }) as HTMLSelectElement;
    fireEvent.change(filter, { target: { value: "allowed" } });
    expect(screen.getByRole("combobox", { name: "Open Native CRM access" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Edit client websites access" })).toBeNull();

    fireEvent.change(filter, { target: { value: "restricted" } });
    expect(screen.queryByRole("combobox", { name: "Open Native CRM access" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Edit client websites access" })).toBeTruthy();

    fireEvent.change(filter, { target: { value: "customized" } });
    expect(screen.getByRole("combobox", { name: "Open Native CRM access" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Edit client websites access" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Manage client projects and updates access" })).toBeNull();
  });

  it("shows protected actions as policy controlled and keeps them outside per-person overrides", () => {
    renderDetails();
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));
    fireEvent.change(screen.getByLabelText("Search permissions"), { target: { value: "Manage agency team and permissions" } });
    expect(screen.getByText("Super Admin only")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Manage agency team and permissions access" })).toBeNull();
  });

  it("shows module access as the parent gate when a child action is individually allowed", () => {
    const view = makeView();
    view.members[0].permissionOverrides = {
      "website.view": "deny",
      "website.edit": "allow",
      "projects.view": "deny",
      "projects.manage": "allow",
    };
    renderDetails(view);
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));

    const websiteEdit = screen.getByRole("combobox", { name: "Edit client websites access" }) as HTMLSelectElement;
    const projectManage = screen.getByRole("combobox", { name: "Manage client projects and updates access" }) as HTMLSelectElement;
    expect(websiteEdit.value).toBe("allow");
    expect(projectManage.value).toBe("allow");
    expect(websiteEdit.parentElement?.textContent).toContain("Blocked by Website Studio view access");
    expect(projectManage.parentElement?.textContent).toContain("Blocked by Projects view access");
  });

  it("previews invitation actions as blocked when their module view access is denied", async () => {
    render(<InviteStaff clients={[]} roleDefaults={roleDefaults} />);
    fireEvent.click(screen.getByRole("button", { name: "Invite teammate" }));
    fireEvent.click(screen.getByRole("button", { name: "Customize permissions (optional)" }));
    fireEvent.click(screen.getByRole("switch", { name: "View Website Studio for invitation" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(screen.getByRole("switch", { name: "Edit client websites for invitation" }).parentElement?.textContent).toContain("Blocked by Website Studio view access");
  });

  it("searches, previews and confirms a scoped permission copy, and compares members", async () => {
    const view = makeView();
    view.members[1].permissionOverrides = { "crm.view": "allow" };
    renderDetails(view);
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Choose team member to compare" }), { target: { value: "manager-1" } });
    expect(screen.getByRole("cell", { name: "Client scope" })).toBeTruthy();
    expect(screen.getAllByText("Open Native CRM").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole("combobox", { name: "Copy permissions from teammate" }), { target: { value: "manager-1" } });
    fireEvent.change(screen.getByLabelText("Search permissions to copy"), { target: { value: "Open Native CRM" } });
    expect(screen.getByRole("button", { name: "Select matching (1)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select matching (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview selected changes" }));
    expect(screen.getByRole("status").textContent).toContain("Copy 1 selected states from Manager One");
    expect(mocks.copyPermissionsAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await waitFor(() => expect(mocks.copyPermissionsAction).toHaveBeenCalledWith({
      sourceUserId: "manager-1",
      targetUserId: "staff-1",
      permissions: ["crm.view"],
      expectedRevision: "3",
    }));
  });

  it("shows the destination's module-gated outcome when copying an allowed website action", () => {
    const view = makeView();
    view.members[0].permissionOverrides = { "website.view": "deny" };
    view.members[1].permissionOverrides = { "website.view": "allow", "website.edit": "allow" };
    renderDetails(view);
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Copy permissions from teammate" }), { target: { value: "manager-1" } });
    fireEvent.change(screen.getByLabelText("Search permissions to copy"), { target: { value: "Edit client websites" } });
    fireEvent.click(screen.getByRole("button", { name: "Select matching (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview selected changes" }));

    const preview = screen.getByRole("status");
    expect(preview.textContent).toContain("Edit client websites: Restricted · Blocked by Website Studio view access → Restricted · Blocked by Website Studio view access (source: Allowed; role default)");
    expect(screen.getByRole("alert").textContent).toContain("The copy will not change module view access");
    expect(mocks.copyPermissionsAction).not.toHaveBeenCalled();
  });

  it("asks before navigating away from unsaved edits and lets the owner stay or discard", async () => {
    renderDetails();
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));
    fireEvent.click(screen.getByText("Native CRM").closest("summary")!);
    fireEvent.change(screen.getByRole("combobox", { name: "Open Native CRM access" }), { target: { value: "allow" } });

    fireEvent.click(screen.getByRole("link", { name: /Back to Agency Team/ }));
    expect(await screen.findByRole("dialog", { name: "Leave without saving?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stay on this page" }));
    expect(mocks.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("link", { name: /Back to Agency Team/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes and leave" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/admin/team"));
  });

  it("confirms client scope changes and filters the activity log", async () => {
    const view = makeView();
    view.members[0].activity = [
      { actorName: "Owner", actorRole: "agency_super_admin", action: "team.permissions_updated", result: "success", occurredAt: "2026-10-01T12:00:00.000Z", targetType: "user", metadata: { changes: [{ permission: "contacts.delete", from: "role_default_deny", to: "allow" }] } },
      { actorName: "Staff One", actorRole: "agency_staff", action: "auth.login", result: "success", occurredAt: "2026-10-01T11:00:00.000Z", targetType: "session", metadata: {} },
    ];
    renderDetails(view);
    fireEvent.click(screen.getByRole("tab", { name: "Assigned Clients" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Assign Staff One to Client Alpha" }));
    expect(screen.getByRole("dialog", { name: "Confirm client assignment" })).toBeTruthy();
    expect(mocks.assignStaffAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm assignment" }));
    await waitFor(() => expect(mocks.assignStaffAction).toHaveBeenCalledWith("client-1", "staff-1", true, "3"));

    fireEvent.click(screen.getByRole("tab", { name: "Activity Log" }));
    fireEvent.click(screen.getByRole("button", { name: "Important events" }));
    expect(screen.getByText("Permissions changed")).toBeTruthy();
    expect(screen.getByText("Archive and delete contacts: role default deny → allow")).toBeTruthy();
    expect(screen.queryByText("Auth · Login")).toBeNull();
  });
});
