# When to Mock

Mock at **system boundaries** only — and "boundary" means anything your module doesn't own and shouldn't construct. Boundaries get **injected**, not encapsulated. Use the same injection pattern whether the test-time implementation is a real provider, a fake, or an in-memory variant:

- External APIs (payment, email, etc.) — inject the client
- Databases — inject the connection or store; use an in-memory implementation in tests, real DB in production. Don't construct the db inside a factory "for test isolation" — that just hides what should be wired.
- Time/randomness — inject a clock or RNG
- File system — inject an FS adapter

A test-time in-memory implementation is not the same as encapsulation: you still pass it in.

Don't mock:

- Your own classes/modules
- Internal collaborators
- Anything you control

## Designing for Mockability

At system boundaries, design interfaces that are easy to mock:

**1. Use dependency injection**

Pass external dependencies in rather than creating them internally:

```typescript
// Easy to mock
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// Hard to mock
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
```

**2. Prefer SDK-style interfaces over generic fetchers**

Create specific functions for each external operation instead of one generic function with conditional logic:

```typescript
// GOOD: Each function is independently mockable
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  getOrders: (userId) => fetch(`/users/${userId}/orders`),
  createOrder: (data) => fetch('/orders', { method: 'POST', body: data }),
};

// BAD: Mocking requires conditional logic inside the mock
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
};
```

The SDK approach means:
- Each mock returns one specific shape
- No conditional logic in test setup
- Easier to see which endpoints a test exercises
- Type safety per endpoint

## Mock implementations return one fixed shape

Each mock function should return a single, fixed shape — no `if` branches inside the mock body. Vary behavior **between tests** using the test runner's per-call override, not factory parameters that switch behavior:

```typescript
// BAD: factory configures the mock body to branch
function makePaymentClient({ chargeError = null } = {}) {
  return {
    charge: jest.fn(async () => {
      if (chargeError) throw chargeError;   // ← conditional logic in the mock
      return { chargeId: 'ch_123' };
    }),
  };
}

// GOOD: mock returns one shape; override per-test when needed
function makePaymentClient() {
  return {
    charge: jest.fn().mockResolvedValue({ chargeId: 'ch_123' }),
  };
}

test('propagates PaymentError when the charge is declined', async () => {
  const paymentClient = makePaymentClient();
  paymentClient.charge.mockRejectedValueOnce(new PaymentError('Declined'));
  // ...
});
```

The factory builds the default shape; the test customises it per-call. This keeps the mock obvious at the call site and avoids growing factory option bags every time a new failure mode is tested.

## Mock anti-patterns

### Asserting on mocks

Mocks are tools to isolate, not things to test. Assert on **observable behavior** (return values, thrown errors, state changes via the public interface), not on whether a mock was called.

```typescript
// BAD: testing that the mock was called
test('processOrder charges the customer', async () => {
  const paymentClient = makePaymentClient();
  await processOrder(order, { paymentClient });
  expect(paymentClient.charge).toHaveBeenCalledWith(5000, 'cust-42');
});

// GOOD: testing observable behavior
test('processOrder returns a paid order with the chargeId', async () => {
  const paymentClient = makePaymentClient();
  const result = await processOrder(order, { paymentClient });
  expect(result.status).toBe('paid');
  expect(result.chargeId).toBe('ch_123');
});
```

If the only thing a test can assert is that a mock was called, the function under test has no observable behavior — that's a design smell. Give it a return value, or verify the side effect via the public interface (e.g., `orderRepository.findById(orderId)` returns the paid record).

### Test-only methods in production

If a method exists only because tests need it (`reset()`, `clear()`, `setInternalState()`), it doesn't belong on the production class. It pollutes the public interface and risks accidental production use.

```typescript
// BAD: destroy() only called by tests
class Session {
  async destroy() { /* cleanup */ }
}
afterEach(() => session.destroy());

// GOOD: cleanup lives in test utilities
async function cleanupSession(session) { /* cleanup */ }
afterEach(() => cleanupSession(session));
```

Test-time setup and teardown belong in test utilities, factories, or fixtures — not on the class under test.
