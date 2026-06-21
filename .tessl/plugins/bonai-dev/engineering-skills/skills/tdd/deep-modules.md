# Deep Modules

From "A Philosophy of Software Design":

**Deep module** = small interface + lots of implementation

```
┌─────────────────────┐
│   Small Interface   │  ← Few methods, simple params
├─────────────────────┤
│                     │
│                     │
│  Deep Implementation│  ← Complex logic hidden
│                     │
│                     │
└─────────────────────┘
```

**Shallow module** = large interface + little implementation (avoid)

```
┌─────────────────────────────────┐
│       Large Interface           │  ← Many methods, complex params
├─────────────────────────────────┤
│  Thin Implementation            │  ← Just passes through
└─────────────────────────────────┘
```

When designing interfaces, ask:

- Can I reduce the number of methods?
- Can I simplify the parameters?
- Can I hide more complexity inside?

## Scope: internal complexity only

Deep modules apply to **internal** logic — algorithms, state machines, calculation pipelines, parsing, business rules. They do **not** apply to collaborators your module doesn't own:

- Databases, HTTP clients, email providers, clocks, files, queues

Those are **boundaries**, and boundaries are injected (see [mocking.md](mocking.md)). A repository whose constructor takes no `db` parameter "for a smaller interface" isn't a deep module — it's a module that has hidden its wiring and made itself untestable.

Quick check: if you'd want to swap the collaborator in a test, it's a boundary. Inject it.
