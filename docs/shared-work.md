# Task-centered bot collaboration

Shared deliverables have one durable owner and conversation, rather than a
new chain of independent bot chats on each trigger:

```text
Topic room (Payments, Releases, Incident response, …)
  Shared task (one deliverable, objective and acceptance criteria)
    Linked specialist threads (one per participating bot)
```

This is not specific to Jira. A story, release, investigation, document or
other multi-bot deliverable uses the same task record. The topic's existing
room conversations remain usable alongside shared tasks.

## Working together

Chief and peer instructions route new shared deliverables through
`get_work_item` and `ensure_work_item`. The caller supplies a stable identity,
such as `jira:account-a:PAY-123` or `release:product-a:2026-09`, along with the
objective and acceptance criteria. Identities are scoped to the coordinator's
team. Titles and polling timestamps are not identities.

The server creates or reuses the topic room and task hub, then transfers
coordination to that hub. The original chat, routine or webhook run observes
the task instead of running a second coordinator. Results are mirrored back
once per source conversation and task revision. A routine remains waiting
until its shared work reaches an outcome.

Within the hub, `coordinate_bots` with `intent=work` creates linked specialist
threads. Nested specialists inherit the task; permission checks follow each
actual delegation edge. They receive a bounded task snapshot and return
results to their lead. Only the coordinator records the overall outcome with
`update_work_item`. Standalone questions use `intent=consultation` without
creating a task hub.

## Choosing task boundaries

The unit of organization is an independently verifiable outcome, not an app,
bot, message or workflow step. A topic can collect a product release,
customer engagement, incident or research area. Each separate deliverable
gets a focused task; implementation, review and corrections for that same
deliverable stay together.

For example, implementing a refund fix and checking that fix share a task.
Producing a customer-research findings report and preparing an independently
deliverable pricing experiment can be separate tasks in the same product
topic. A discussion, clarification or specialist handoff is not by itself
a reason to create another task. Work with materially different context,
access requirements or lifecycles may need separate tasks.

An external issue key makes identity straightforward, but is not required.
For generic work, the coordinator chooses a durable project/outcome key and
reuses it. Existing context and artifact references should inform that choice.

When asked to begin the next work, the coordinator reads authorized priority
sources, dependencies, existing tasks and available capacity, or first asks
the planning teammate through a bounded consultation. The originating
coordinator can then create the chosen delivery tasks in the same request;
the consulted specialist cannot start a competing coordinator. A request to
begin execution is not replaced with a readiness audit. Missing priorities
or access are reported rather than invented. These are model instructions,
not a Jira-specific ranking algorithm or a promise of perfect semantic
grouping.

## Sidebar organization

The task panel shows status, owner, brief, criteria, assignments, results,
decisions, artifact references and evidence. Opening a specialist selects its
exact linked thread. Shared topics use a distinct folder icon and accent
treatment. Each focused task expands into its shared chat and all linked
specialist conversations, with status and attention indicators:

```text
Product discovery                         [work topic]
  Customer onboarding findings            [focused task]
    Shared chat                           Manager
    Research Analyst                      Working
    Research Reviewer                     Waiting
  Pricing experiment proposal             [focused task]
    Shared chat                           Manager
    Product Specialist                    Working
```

Linked workers are not duplicated under individual bots, including their
activity lists; global attention shortcuts remain available. Selecting a
worker keeps its topic/task expanded and highlights the exact thread.
Search can find a task by outcome, specialist name or assignment context.
Earlier-revision worker conversations remain in their task. A worker whose
hub is unavailable stays reachable under its bot instead of disappearing.

Messages in a shared hub add steering context
for the coordinator's next step; they do not start another coordination loop.

## Loop prevention

- A stable task identity reuses existing active or settled work. New request
  keys and different assignment wording do not redispatch the same bot's work.
- There is one assignment per bot per revision. Further phases for that bot
  require explicit rework: the existing assignment ID and a changed brief.
  At most two automatic corrections are permitted.
- Each revision permits at most 24 specialist assignments and 48 execution
  admissions, including coordinator follow-ups. A four-hour wall-clock cap
  and the existing handoff engine's tighter limits also apply.
- Completion requires all current assignments to succeed, the current
  revision, a concrete outcome, evidence and every acceptance criterion
  reported as checked. The server enforces these records; it does not
  independently establish that an agent's claimed checks actually ran.
- Unchanged completed, blocked or cancelled tasks do not restart on another
  routine tick. A changed `input` fingerprint or explicit user reopen creates
  a new revision, after existing workers have settled. Supply only meaningful
  source changes in `input`, never delivery timestamps or polling metadata.
- **Stop shared task** cancels the coordinator and queued work but lets
  already-running specialists finish. Late results cannot reopen the task.
  Reopen becomes possible once those workers settle.
- Restart blocks interrupted tasks and fails unfinished assignments without
  replay. Portable team backups remap task links and do not replay imported
  work; full workspace backups retain task records and apply restart recovery.

## Boundaries

The registry lives in `work-items.json`; execution still uses `RoomHandoffs`,
not an additional scheduler. Existing peer permissions, team scope, approval
and runtime capability checks remain in force. Shared context is not an
access grant. Credentials are not propagated through the task registry.

Signed-in members can see only tasks whose topic, hub and coordinator they
can access. HTTP and event-stream responses remove inaccessible assignments
and worker results. Task creation cannot copy a private room's context into
a coordinator with a wider audience. Reused handoff results remain scoped
to the source bot/room and task revision, and recheck both the original and
current route permissions before returning cached data.

“Shared workspace” currently means a shared brief, state, decisions, results
and artifact references. A room's working-folder reference is included in
context, but files are not synchronized between bot environments and worker
working directories are not automatically changed.

This is an additive rollout: legacy delegation callers and existing chats
are retained. New tool instructions favor shared tasks, and explicitly
declared work cannot dispatch from an unbound source. Identity selection and
meaningful-input selection still depend on the caller; arbitrary existing
conversations are not automatically merged or semantically deduplicated.

See [isolated verification](verification/shared-work.md) for coverage and
reproducible commands. To add Jira, GitLab, Plane, or another tracker, see
[task connectors](connectors.md). Product direction — reconciliation,
gates, leases, kits — is in [vision](vision/README.md).
