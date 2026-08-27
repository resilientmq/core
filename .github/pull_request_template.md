## Summary

<!-- Describe the problem and the resulting behavior. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Refactor
- [ ] Documentation

## Verification

- [ ] `npm run build`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:stress`
- [ ] `npm run test:benchmark`
- [ ] `npm audit`

## Resilience checklist

- [ ] ACK/reject/requeue behavior is covered by tests.
- [ ] Publisher confirms and unroutable messages are covered.
- [ ] Retry and DLQ attempts use RabbitMQ-owned headers.
- [ ] Multi-replica claims and expired leases are covered.
- [ ] Connection loss and bounded shutdown are covered.
- [ ] Public API and migration notes are documented.

## Related issue

<!-- Link a related issue when one exists. Use N/A when the change has no tracked issue. -->

Closes #
