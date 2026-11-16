import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Folder, Invitation, ServiceAccount, Team, TeamOverview } from "./api.ts";
import { ServiceAccountApproval } from "./ServiceAccounts.tsx";
import { InvitationList, TeamList } from "./Teams.tsx";
import { restoreFetch, stubFetch } from "./testing.ts";
import { UploadDialog } from "./UploadDialog.tsx";

const confirm = window.confirm;

afterEach(() => {
  restoreFetch();
  window.confirm = confirm;
});

type Sent = { method: string; path: string; body: unknown };

const LEGAL: Team = {
  id: "legal",
  name: "Legal",
  createdAt: new Date().toISOString(),
  members: [{ id: "member-1", name: "Member", email: "member@acme.example", guest: false }],
  folderIds: ["contracts"],
};

const OVERVIEW: TeamOverview = {
  teams: [LEGAL],
  people: [
    {
      id: "member-1",
      name: "Member",
      email: "member@acme.example",
      guest: false,
      serviceAccount: false,
    },
    {
      id: "guest-1",
      name: "Guest",
      email: "guest@partner.example",
      guest: true,
      serviceAccount: false,
    },
  ],
  folders: [
    { id: "contracts", name: "Contracts", parentId: null },
    { id: "open", name: "Open", parentId: null },
    { id: "drafts", name: "Drafts", parentId: "open" },
  ],
};

/** Answers every admin call with `OVERVIEW` and records each change. */
function serveTeams(sent: Sent[], invitations: Invitation[] = []) {
  stubFetch((path, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      sent.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    }
    if (path === "/api/invitations") {
      return method === "GET"
        ? { body: { invitations } }
        : { status: 201, body: { invitation: invitations[0] } };
    }
    if (path.startsWith("/api/invitations/")) return { body: {} };
    if (path === "/api/teams" && method === "GET") return { body: OVERVIEW };
    return { body: { team: LEGAL } };
  });
}

describe("the teams page", () => {
  test("creates a team with the name given", async () => {
    const sent: Sent[] = [];
    serveTeams(sent);
    render(<TeamList />);
    fireEvent.change(await screen.findByLabelText("New team"), { target: { value: " Finance " } });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    await waitFor(() =>
      expect(sent).toEqual([{ method: "POST", path: "/api/teams", body: { name: "Finance" } }]),
    );
  });

  test("adds a member chosen from every account not in the team", async () => {
    const sent: Sent[] = [];
    serveTeams(sent);
    render(<TeamList />);
    const select = (await screen.findByLabelText("Add a member to Legal")) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["", "guest-1"]);
    fireEvent.change(select, { target: { value: "guest-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(sent).toEqual([
        { method: "PUT", path: "/api/teams/legal/members/guest-1", body: undefined },
      ]),
    );
  });

  // The first team on a folder hides it from everyone else and revokes its
  // public links, so the admin confirms first.
  test("asks before restricting a folder that has no team, and sends nothing when cancelled", async () => {
    const sent: Sent[] = [];
    serveTeams(sent);
    const asked: string[] = [];
    window.confirm = (text) => {
      asked.push(String(text));
      return false;
    };
    render(<TeamList />);
    const select = (await screen.findByLabelText(
      "Restrict a folder to Legal",
    )) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Restrict a folder...",
      "Open",
      "Open › Drafts",
    ]);
    fireEvent.change(select, { target: { value: "drafts" } });
    fireEvent.click(screen.getByRole("button", { name: "Restrict" }));
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toContain("Public links");
    expect(sent).toEqual([]);

    window.confirm = () => true;
    fireEvent.click(screen.getByRole("button", { name: "Restrict" }));
    await waitFor(() =>
      expect(sent).toEqual([
        { method: "PUT", path: "/api/teams/legal/folders/drafts", body: undefined },
      ]),
    );
  });
});

describe("the invitations page", () => {
  const invitation = (overrides: Partial<Invitation> = {}): Invitation => ({
    id: "invitation-1",
    email: "guest@partner.example",
    teamIds: ["legal"],
    invitedBy: { id: "admin-1", name: "An Admin" },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    acceptedAt: null,
    ...overrides,
  });

  test("invites an address into the chosen teams", async () => {
    const sent: Sent[] = [];
    serveTeams(sent, [invitation()]);
    render(<InvitationList />);
    fireEvent.change(await screen.findByLabelText("Email address"), {
      target: { value: "new@partner.example" },
    });
    const invite = screen.getByRole("button", { name: "Invite" }) as HTMLButtonElement;
    expect(invite.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Legal"));
    fireEvent.click(invite);
    await waitFor(() =>
      expect(sent).toEqual([
        {
          method: "POST",
          path: "/api/invitations",
          body: { email: "new@partner.example", teamIds: ["legal"] },
        },
      ]),
    );
  });

  test("revokes an open invitation, and offers nothing for an accepted one", async () => {
    const sent: Sent[] = [];
    serveTeams(sent, [
      invitation(),
      invitation({
        id: "invitation-2",
        email: "done@partner.example",
        acceptedAt: new Date().toISOString(),
      }),
    ]);
    render(<InvitationList />);
    expect(await screen.findByText("Accepted")).toBeDefined();
    const revoke = screen.getAllByRole("button", { name: "Revoke" });
    expect(revoke).toHaveLength(1);
    fireEvent.click(revoke[0] as HTMLElement);
    await waitFor(() =>
      expect(sent).toEqual([
        { method: "DELETE", path: "/api/invitations/invitation-1", body: undefined },
      ]),
    );
  });
});

describe("approving a service account with teams", () => {
  const approved: ServiceAccount = {
    id: "account-1",
    clientId: "client-1",
    name: "Review runner",
    approvedBy: { id: "admin-1", name: "An Admin" },
    createdAt: new Date().toISOString(),
    renewedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    disabledAt: null,
    guest: true,
  };

  function serveApproval(sent: unknown[]) {
    stubFetch((path, init) => {
      if (path === "/api/service-accounts/enrollments/enrollment-1/approval") {
        if (init?.method === "POST") {
          sent.push(JSON.parse(String(init.body)));
          return { body: { account: approved } };
        }
        return {
          body: {
            enrollment: {
              id: "enrollment-1",
              name: "Review runner",
              userCode: "BCDFGHJK",
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            },
          },
        };
      }
      if (path === "/api/service-accounts") return { body: { accounts: [] } };
      if (path === "/api/teams") return { body: OVERVIEW };
      return { status: 404, body: { error: { code: "NOT_FOUND", message: "No." } } };
    });
  }

  test("makes a new account a guest only in the teams chosen", async () => {
    const sent: unknown[] = [];
    serveApproval(sent);
    render(<ServiceAccountApproval id="enrollment-1" teams onDone={() => {}} />);
    fireEvent.click(await screen.findByLabelText(/^Guest/));
    const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(await screen.findByLabelText("Legal"));
    fireEvent.click(approve);
    await screen.findByText("Approved");
    expect(sent).toEqual([{ guest: true, teamIds: ["legal"] }]);
  });

  test("approves a member when the admin keeps the default", async () => {
    const sent: unknown[] = [];
    serveApproval(sent);
    render(<ServiceAccountApproval id="enrollment-1" teams onDone={() => {}} />);
    expect(await screen.findByLabelText(/^Member/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("Approved");
    expect(sent).toEqual([{}]);
  });
});

describe("a guest's upload", () => {
  test("offers only the guest's folders, and no unfiled or new top-level choice", async () => {
    const folders: Folder[] = [
      { id: "contracts", name: "Contracts", parentId: null, artifactCount: 1 },
    ];
    stubFetch((path) => (path === "/api/folders" ? { body: { folders } } : { body: {} }));
    render(
      <UploadDialog
        maxUploadBytes={1024 * 1024}
        privateArtifacts
        guest
        onClose={() => {}}
        onUploaded={() => {}}
      />,
    );
    const select = (await screen.findByLabelText("Folder")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("contracts"));
    expect([...select.options].map((option) => option.value)).toEqual(["contracts"]);
  });
});
