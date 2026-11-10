import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ServiceAccount } from "./api.ts";
import { ServiceAccountApproval, ServiceAccountList } from "./ServiceAccounts.tsx";
import { restoreFetch, stubFetch } from "./testing.ts";

const confirm = window.confirm;

afterEach(() => {
  restoreFetch();
  window.confirm = confirm;
});

const ENROLLMENT = {
  id: "enrollment-1",
  name: "Review runner",
  userCode: "BCDFGHJK",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
};

function account(overrides: Partial<ServiceAccount> = {}): ServiceAccount {
  return {
    id: "account-1",
    clientId: "client-1",
    name: "Nightly digest",
    approvedBy: { id: "admin-1", name: "An Admin" },
    createdAt: new Date().toISOString(),
    renewedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    disabledAt: null,
    ...overrides,
  };
}

/** Answers the approval page's calls and records what it sent to approve. */
function serveApproval(sent: unknown[], accounts: ServiceAccount[] = [account()]) {
  stubFetch((path, init) => {
    if (path === "/api/service-accounts/enrollments/enrollment-1/approval") {
      if (init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)));
        return { body: { account: account({ name: "Review runner" }) } };
      }
      return { body: { enrollment: ENROLLMENT } };
    }
    if (path === "/api/service-accounts") return { body: { accounts } };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "No." } } };
  });
}

describe("the approval page", () => {
  // The admin compares this with the agent's terminal, which prints it the same way.
  test("shows the code as the terminal prints it", async () => {
    serveApproval([]);
    render(<ServiceAccountApproval id="enrollment-1" onDone={() => {}} />);
    expect(await screen.findByText("BCDF-GHJK")).toBeDefined();
  });

  test("approves a new account by default", async () => {
    const sent: unknown[] = [];
    serveApproval(sent);
    render(<ServiceAccountApproval id="enrollment-1" onDone={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Approved")).toBeDefined();
    expect(sent).toEqual([{}]);
  });

  test("can give the key to an existing account, which re-enrolls it", async () => {
    const sent: unknown[] = [];
    serveApproval(sent);
    render(<ServiceAccountApproval id="enrollment-1" onDone={() => {}} />);
    fireEvent.click(await screen.findByLabelText("Give Nightly digest this key (active)"));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("Approved");
    expect(sent).toEqual([{ accountId: "account-1" }]);
  });

  // Names are not unique, and giving the key to an active account locks out
  // the agent that runs it.
  test("tells accounts with the same name apart by their status", async () => {
    serveApproval(
      [],
      [
        account(),
        account({ id: "account-2", disabledAt: new Date(Date.now() - 60_000).toISOString() }),
      ],
    );
    render(<ServiceAccountApproval id="enrollment-1" onDone={() => {}} />);
    expect(await screen.findByLabelText("Give Nightly digest this key (active)")).toBeDefined();
    expect(screen.getByLabelText("Give Nightly digest this key (disabled)")).toBeDefined();
  });

  test("says so when the request expired", async () => {
    stubFetch(() => ({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "No such enrollment, or it expired." } },
    }));
    render(<ServiceAccountApproval id="enrollment-1" onDone={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("expired");
  });
});

describe("the account list", () => {
  test("shows each account's status and disables one", async () => {
    const disabled: string[] = [];
    window.confirm = () => true;
    stubFetch((path, init) => {
      if (path === "/api/service-accounts") {
        return {
          body: {
            accounts: [
              account(),
              account({
                id: "account-2",
                name: "Old runner",
                // The page's clock moves once a minute.
                expiresAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
              }),
            ],
          },
        };
      }
      if (path === "/api/service-accounts/account-1/disable" && init?.method === "POST") {
        disabled.push("account-1");
        return { body: { account: account({ disabledAt: new Date().toISOString() }) } };
      }
      return { status: 404, body: {} };
    });
    render(<ServiceAccountList />);
    expect(await screen.findByText("Nightly digest")).toBeDefined();
    expect(screen.getByText("Expired")).toBeDefined();
    expect(screen.getByText("Active")).toBeDefined();

    fireEvent.click(screen.getAllByRole("button", { name: "Disable" })[0] as HTMLElement);
    expect(await screen.findByText("Disabled")).toBeDefined();
    expect(disabled).toEqual(["account-1"]);
  });
});
