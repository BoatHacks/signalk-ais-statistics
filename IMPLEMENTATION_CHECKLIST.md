# Implementation Checklist - Quick Reference

Work through this in order before and while implementing a change.

## Phase 1: Explore
- [ ] Read the relevant issue or roadmap item fully
- [ ] Read the relevant sections of [SPEC.md](SPEC.md)
- [ ] Read the relevant sections of [ARCHITECTURE.md](ARCHITECTURE.md)
- [ ] Check the open questions in SPEC section 13: does this change depend on
      one that is still unverified? If so, do the spike first
- [ ] Explore existing code before writing anything

## Phase 2: Plan
- [ ] Think through the approach and alternatives
- [ ] Write a short plan from [docs/plans/plan-template.md](docs/plans/plan-template.md)
      and save it as `docs/plans/issue-<n>-<slug>.md`
- [ ] Identify test scenarios up front, including bad input (bogus positions,
      malformed or truncated sentences, missing own position)

## Phase 3: Test
- [ ] Write tests first
- [ ] Confirm they fail for the right reason
- [ ] Commit the tests separately from the implementation
- [ ] Use synthetic or publicly available AIS sentences as fixtures. Never
      commit recordings from a real vessel or station: they contain real
      positions and MMSIs, and this repository is public

## Phase 4: Implement
- [ ] Write code to satisfy the tests and the plan
- [ ] Run tests, type check and lint frequently, not just at the end
- [ ] If a test seems wrong, fix the test deliberately; do not loosen it
      just to get to green
- [ ] Keep the pure parts pure: the aggregator, classifier and geo code take
      an injectable clock and do no I/O

## Phase 5: Verify
- [ ] Check edge cases, not just the happy path
- [ ] Confirm the change matches SPEC.md
- [ ] Confirm the change follows ARCHITECTURE.md
- [ ] If published paths changed, `src/paths.ts` is the only place they are
      defined and the history reader uses the same constants
- [ ] If the change touches the web app or the overlay, check it at phone
      width and with no internet connection

## Phase 6: Document and Commit
- [ ] Update SPEC.md and ARCHITECTURE.md if this change altered what they
      describe, and move resolved items out of SPEC section 13
- [ ] Remove temporal language from comments ("new", "recently added");
      comments should read correctly a year from now
- [ ] Nothing private in the diff: no real MMSIs, station or vessel names,
      coordinates, hostnames, IP addresses, tokens or screenshots
- [ ] All tests pass, code is linted and formatted
- [ ] Commit with a message that explains why, referencing the issue

---

## Common Mistakes to Avoid

**Don't:**
- Jump straight to coding before reading SPEC.md and ARCHITECTURE.md
- Skip writing tests first
- Loosen a test to make it pass instead of fixing the real issue
- Trust the maximum distance anywhere a percentile will do (SPEC 2.3)
- Filter or drop positions in the aggregator; the only cap is the coverage
  percentile cap (SPEC 2.4)
- Leave SPEC.md or ARCHITECTURE.md stale after a change that contradicts them

**Do:**
- Explore before planning, plan before coding
- Write down the plan somewhere reviewable, even briefly
- Verify against the docs, not just against your own memory of the task
- Publish only numeric values as paths; anything else belongs in the daily
  cell-set files (SPEC section 8)
