"""Scheduler ordering and RNG stream independence."""
import unittest

import numpy as np

from rmemfab.core.rng import make_rng, stream_seeds
from rmemfab.core.scheduler import Scheduler


class TestScheduler(unittest.TestCase):
    def test_same_time_runs_in_schedule_order(self):
        s = Scheduler()
        seen = []
        s.schedule(10, "b")
        s.schedule(5, "a")
        s.schedule(10, "c")
        s.run(lambda kind, data, now, seq: seen.append((now, kind)), 10)
        self.assertEqual(seen, [(5, "a"), (10, "b"), (10, "c")])
        self.assertEqual(s.processed, 3)

    def test_end_bound_is_inclusive_and_stops(self):
        s = Scheduler()
        seen = []
        s.schedule(5, "a")
        s.schedule(99, "b")
        s.run(lambda kind, data, now, seq: seen.append(kind), 10)
        self.assertEqual(seen, ["a"])
        self.assertEqual(s.pending(), 1)

    def test_schedule_in_past_raises(self):
        s = Scheduler()
        s.schedule(5, "a")
        s.run(lambda *a: None, 10)
        with self.assertRaises(ValueError):
            s.schedule(4, "b")


class TestRng(unittest.TestCase):
    def test_same_seed_same_stream_reproducible(self):
        a = make_rng(7, "workload").random(5)
        b = make_rng(7, "workload").random(5)
        np.testing.assert_array_equal(a, b)

    def test_streams_are_independent(self):
        a = make_rng(7, "workload").random(5)
        b = make_rng(7, "policy").random(5)
        self.assertFalse(np.array_equal(a, b))

    def test_stream_seeds_stable(self):
        self.assertEqual(stream_seeds(7), stream_seeds(7))
        self.assertNotEqual(stream_seeds(7), stream_seeds(8))


if __name__ == "__main__":
    unittest.main()
