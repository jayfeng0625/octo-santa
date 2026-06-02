// tests/conformance/in-memory.test.ts
//
// Runs the parameterized PubSub conformance suite against the InMemory reference impl
// (spec §3, §4). InMemory descriptor:
//   { durable: false, replayable: true, delivery: "at-least-once", topicLifecycle: "implicit" }
// Expected: all CORE + implicit + at-least-once sections GREEN; the explicit branch and the
// durable (cross-process/restart) section reported SKIPPED, not failed.

import { createBackplane, connectInMemoryPeer } from "../../src/adapters/in-memory/in-memory-pubsub";
import type { ConformanceHarness, HarnessFactory } from "./harness";
import { runConformanceSuite } from "./suite";

// Each factory() call mints a FRESH hermetic backplane instance (spec §4) — parallel test
// files must not cross-contaminate. `connect(name)` mints peers on THAT instance; cleanup
// disposes it (in-memory: nothing to release, the backplane is GC'd once unreferenced).
const inMemoryFactory: HarnessFactory = async (): Promise<ConformanceHarness> => {
  const bp = createBackplane();
  return {
    connect: (name) => connectInMemoryPeer(bp, name),
    cleanup: async () => {
      // InMemory has no external resources; dropping the reference is enough.
    },
  };
};

await runConformanceSuite("InMemory", inMemoryFactory);
