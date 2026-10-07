import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { SignIn } from "./SignIn.tsx";

test("names the deployment before anyone signs in, with no session to read it from", () => {
  render(<SignIn providers={[]} refusal={null} onChoose={async () => {}} />);
  const logo = screen.getByRole("img", { name: "Test App" });
  expect(logo.getAttribute("src")).toBe("/branding/logo-full.png");
});
