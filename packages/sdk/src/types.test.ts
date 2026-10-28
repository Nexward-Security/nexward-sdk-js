import type * as Contract from "@nexward/types";
import { describe, expect, it } from "vitest";
import type { ActionContext, ApprovalStatus, Decision, Severity } from "./types.ts";

// Compile-time equality: the SDK's public types must match the wire contract exactly.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the standard exact type-equality idiom; T is the point
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const checks: [
  Equal<Decision, Contract.Decision>,
  Equal<Severity, Contract.Severity>,
  Equal<ApprovalStatus, Contract.ApprovalStatus>,
  Equal<ActionContext, Contract.ActionContext>,
] = [true, true, true, true];

describe("public types", () => {
  it("match @nexward/types", () => {
    expect(checks).toEqual([true, true, true, true]);
  });
});
