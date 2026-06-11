/* Creates a bare fixture repo (no review state) and prints its path. */
import { makeFixtureRepo } from '../tests/helpers/fixtureRepo'
console.log(makeFixtureRepo().dir)
