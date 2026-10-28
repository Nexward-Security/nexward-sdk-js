# @nexward/sdk

Runtime security for AI agents. Wrap each tool your agent can use; Nexward
decides **ALLOW**, **BLOCK**, or **REQUIRE_APPROVAL** before it runs, and the
SDK runs your function only on ALLOW, at most once.

- Server-side JavaScript/TypeScript, Node.js 20 or newer. ES module.
- No runtime dependencies.
- Fails closed: if Nexward cannot be reached or answers unexpectedly, the tool does not run.

Documentation: <https://nexward.ai/docs/api>

## Install

```bash
npm install @nexward/sdk
```

Set two environment variables on your server (never in browser or mobile code):

```bash
NEXWARD_API_KEY=nxw_test_...        # from the Nexward dashboard, Settings > Create API key
NEXWARD_API_URL=https://api.nexward.ai
```

## Protect a tool

```ts
import { Nexward } from "@nexward/sdk";

const nexward = new Nexward(); // reads NEXWARD_API_KEY and NEXWARD_API_URL

const result = await nexward.protect(
  { agentId: "support-agent", tool: "crm.export_customers", arguments: { records: 1000 } },
  (args) => exportCustomers(args.records), // runs only on ALLOW, at most once
);

switch (result.outcome) {
  case "executed":          // ALLOW: result.value is what your function returned
    break;
  case "blocked":           // BLOCK: your function did not run; see result.decision.reasonCodes
    break;
  case "approval_required": // a person must approve; keep result.approvalId and call resume() later
    break;
  case "not_executed":      // Nexward unreachable, invalid key or request: your function did not run
    break;
}
```

The agent key and tool name must be registered in the Nexward dashboard for the
API key's application, and the tool granted to the agent; a published policy
decides the rest.

## Approvals

```ts
const status = await nexward.getApproval(approvalId);
if (status.ok && status.status === "approved") {
  // Same actionId, agentId, tool, and arguments as the original action.
  await nexward.resume(approvalId, originalAction, (args) => sendEmail(args));
}
```

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `apiKey` | `process.env.NEXWARD_API_KEY` | Application API key |
| `baseUrl` | `process.env.NEXWARD_API_URL` | `https://api.nexward.ai` |
| `timeouts` | 1 s per attempt, 2.5 s total, 3 attempts | How long to wait for a decision |
| `failOpenTools` | none | Tools allowed to run when Nexward is unreachable (never on BLOCK or errors) |
| `onEvent` | none | Receives every outcome, for your logging |

`nexward.evaluate(action)` asks for a decision without running anything.

## Security

Report vulnerabilities to hello@nexward.ai.
